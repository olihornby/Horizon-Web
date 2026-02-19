const path = require("path");
const fs = require("fs");
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const nodemailer = require("nodemailer");
const cron = require("node-cron");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const TRUST_PROXY = process.env.TRUST_PROXY;
const BACKUP_CRON = process.env.BACKUP_CRON || "*/15 * * * *";
const BACKLOG_FLUSH_CRON = process.env.BACKLOG_FLUSH_CRON || "*/2 * * * *";
const AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET || ADMIN_KEY || "change-this-auth-secret";
const usePostgres = Boolean(DATABASE_URL);
const startTime = Date.now();
const SMTP_CONNECTION_TIMEOUT_MS = Math.max(1000, Number(process.env.SMTP_CONNECTION_TIMEOUT_MS || 10000));
const SMTP_SOCKET_TIMEOUT_MS = Math.max(1000, Number(process.env.SMTP_SOCKET_TIMEOUT_MS || 10000));
const SMTP_RETRY_COOLDOWN_MS = Math.max(0, Number(process.env.SMTP_RETRY_COOLDOWN_MS || 300000));

function resolveTrustProxySetting() {
  if (!TRUST_PROXY || !TRUST_PROXY.trim()) {
    return process.env.RENDER ? 1 : false;
  }

  const normalized = TRUST_PROXY.trim().toLowerCase();

  if (["true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["false", "no", "off"].includes(normalized)) {
    return false;
  }

  const hops = Number(normalized);
  if (Number.isInteger(hops) && hops >= 0) {
    return hops;
  }

  return TRUST_PROXY;
}

const trustProxySetting = resolveTrustProxySetting();
app.set("trust proxy", trustProxySetting);

const VALID_STATUSES = ["new", "in-progress", "resolved"];

const EMAIL_CONFIG = {
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE || "false") === "true",
  user: process.env.SMTP_USER,
  pass: process.env.SMTP_PASS,
  from: process.env.SMTP_FROM || process.env.SMTP_USER,
  notifyTo: process.env.NOTIFY_EMAIL || process.env.SMTP_USER,
  alertTo: process.env.ALERT_EMAIL || process.env.NOTIFY_EMAIL || process.env.SMTP_USER
};

const dbPath = path.join(__dirname, "inquiries.json");
const auditPath = path.join(__dirname, "audit-log.json");
const inquiryBacklogPath = path.join(__dirname, "inquiry-backlog.json");
const usersPath = path.join(__dirname, "users.json");
const userProgressPath = path.join(__dirname, "user-progress.json");
const uploadsDir = path.join(__dirname, "uploads");
const backupsDir = path.join(__dirname, "backups");

let pool = null;
let mailer = null;
let mailerCooldownUntil = 0;

const monitorState = {
  storageHealthy: true,
  lastStorageCheckAt: null,
  lastStorageError: null,
  backlogPending: 0,
  lastBacklogFlushAt: null,
  lastBacklogFlushError: null,
  lastBackupAt: null,
  lastBackupError: null,
  lastAlertAt: null
};

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function ensureJsonFile(filePath, defaultContent) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, defaultContent, "utf8");
  }
}

function readJsonArray(filePath) {
  ensureJsonFile(filePath, "[]");
  const raw = fs.readFileSync(filePath, "utf8");

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeJsonArray(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function nowIso() {
  return new Date().toISOString();
}

function sanitizeStatus(status) {
  return VALID_STATUSES.includes(status) ? status : "new";
}

function toCsvValue(value) {
  if (value === null || value === undefined) {
    return "";
  }

  const text = String(value).replace(/"/g, '""');
  return /[",\n\r]/.test(text) ? `"${text}"` : text;
}

function toInquiriesCsv(rows) {
  const headers = [
    "id",
    "full_name",
    "company",
    "email",
    "request_type",
    "status",
    "details",
    "attachment_original_name",
    "attachment_size",
    "created_at",
    "updated_at"
  ];
  const lines = [headers.join(",")];

  for (const row of rows) {
    lines.push(
      headers
        .map((header) => {
          const value = row[header];
          if ((header === "created_at" || header === "updated_at") && value) {
            return toCsvValue(new Date(value).toISOString());
          }

          return toCsvValue(value);
        })
        .join(",")
    );
  }

  return lines.join("\n");
}

function getSuppliedAdminKey(req) {
  return (req.query.key || req.headers["x-admin-key"] || req.body?.key || "").toString();
}

function isAuthorizedAdminRequest(req) {
  return Boolean(ADMIN_KEY) && getSuppliedAdminKey(req) === ADMIN_KEY;
}

function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) {
    return res.status(503).json({
      ok: false,
      message: "Admin endpoint is not configured. Set ADMIN_KEY on the server."
    });
  }

  if (!isAuthorizedAdminRequest(req)) {
    return res.status(401).json({
      ok: false,
      message: "Unauthorized"
    });
  }

  return next();
}

function normalizeLikeValue(value) {
  return `%${String(value || "").toLowerCase()}%`;
}

function parsePagination(query) {
  const page = Math.max(1, Number(query.page || 1));
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize || 25)));
  return { page, pageSize };
}

function mapFileMeta(file) {
  if (!file) {
    return {
      attachmentOriginalName: null,
      attachmentStoredName: null,
      attachmentMimeType: null,
      attachmentSize: null
    };
  }

  return {
    attachmentOriginalName: file.originalname,
    attachmentStoredName: file.filename,
    attachmentMimeType: file.mimetype,
    attachmentSize: file.size
  };
}

function pickAllowedFieldsForEdit(body) {
  return {
    fullName: (body.fullName || body["full-name"] || "").trim(),
    company: (body.company || "").trim(),
    email: (body.email || "").trim(),
    requestType: (body.requestType || body["service-type"] || "").trim(),
    details: (body.details || "").trim(),
    status: sanitizeStatus((body.status || "").trim())
  };
}

function createMailer() {
  if (!EMAIL_CONFIG.host || !EMAIL_CONFIG.user || !EMAIL_CONFIG.pass || !EMAIL_CONFIG.notifyTo) {
    console.log("SMTP config incomplete; email notifications and alerts are disabled.");
    return null;
  }

  return nodemailer.createTransport({
    host: EMAIL_CONFIG.host,
    port: EMAIL_CONFIG.port,
    secure: EMAIL_CONFIG.secure,
    connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
    auth: {
      user: EMAIL_CONFIG.user,
      pass: EMAIL_CONFIG.pass
    }
  });
}

async function sendEmail({ to, subject, text }) {
  if (!mailer || !to) {
    return false;
  }

  if (Date.now() < mailerCooldownUntil) {
    return false;
  }

  try {
    await mailer.sendMail({
      from: EMAIL_CONFIG.from,
      to,
      subject,
      text
    });

    return true;
  } catch (error) {
    const code = String(error && error.code ? error.code : "");
    if (["ETIMEDOUT", "ESOCKET", "ECONNECTION"].includes(code)) {
      mailerCooldownUntil = Date.now() + SMTP_RETRY_COOLDOWN_MS;
    }

    console.error("Email send failed", {
      code: code || "UNKNOWN",
      message: error && error.message ? error.message : "Unknown email error"
    });

    return false;
  }
}

async function notifyNewInquiry(row) {
  const text = [
    "New Horizon inquiry received.",
    "",
    `ID: ${row.id}`,
    `Name: ${row.full_name}`,
    `Company: ${row.company || "-"}`,
    `Email: ${row.email}`,
    `Type: ${row.request_type}`,
    `Status: ${row.status}`,
    `Details: ${row.details}`,
    row.attachment_original_name ? `Attachment: ${row.attachment_original_name} (${row.attachment_size || 0} bytes)` : "Attachment: None",
    `Created: ${row.created_at}`
  ].join("\n");

  await sendEmail({
    to: EMAIL_CONFIG.notifyTo,
    subject: `New Inquiry #${row.id} - ${row.request_type}`,
    text
  });
}

async function sendMonitoringAlert(isHealthy, message) {
  if (!EMAIL_CONFIG.alertTo) {
    return;
  }

  const delivered = await sendEmail({
    to: EMAIL_CONFIG.alertTo,
    subject: isHealthy ? "Horizon monitor recovered" : "Horizon monitor alert",
    text: `${message}\n\nTime: ${nowIso()}`
  });

  if (delivered) {
    monitorState.lastAlertAt = nowIso();
  }
}

async function initStorage() {
  ensureDir(uploadsDir);
  ensureDir(backupsDir);
  ensureJsonFile(inquiryBacklogPath, "[]");

  if (!usePostgres) {
    ensureJsonFile(dbPath, "[]");
    ensureJsonFile(auditPath, "[]");
    ensureJsonFile(usersPath, "[]");
    ensureJsonFile(userProgressPath, "[]");
    console.log("Using local JSON storage for inquiries.");
    return;
  }

  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS inquiries (
      id SERIAL PRIMARY KEY,
      full_name TEXT NOT NULL,
      company TEXT,
      email TEXT NOT NULL,
      request_type TEXT NOT NULL,
      details TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      attachment_original_name TEXT,
      attachment_stored_name TEXT,
      attachment_mime_type TEXT,
      attachment_size INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query("ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'new'");
  await pool.query("ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS attachment_original_name TEXT");
  await pool.query("ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS attachment_stored_name TEXT");
  await pool.query("ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS attachment_mime_type TEXT");
  await pool.query("ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS attachment_size INTEGER");
  await pool.query("ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS inquiry_audit (
      id SERIAL PRIMARY KEY,
      inquiry_id INTEGER,
      action TEXT NOT NULL,
      changed_fields JSONB,
      previous_status TEXT,
      new_status TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_project_progress (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_name TEXT NOT NULL,
      status TEXT NOT NULL,
      percent_complete INTEGER NOT NULL DEFAULT 0,
      deadline_date DATE,
      budget_total NUMERIC(12, 2),
      budget_used NUMERIC(12, 2),
      summary TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query("ALTER TABLE user_project_progress ADD COLUMN IF NOT EXISTS deadline_date DATE");
  await pool.query("ALTER TABLE user_project_progress ADD COLUMN IF NOT EXISTS budget_total NUMERIC(12, 2)");
  await pool.query("ALTER TABLE user_project_progress ADD COLUMN IF NOT EXISTS budget_used NUMERIC(12, 2)");

  console.log("Using PostgreSQL storage for inquiries.");
}

async function addAuditEntry(entry) {
  const payload = {
    inquiry_id: entry.inquiryId || null,
    action: entry.action,
    changed_fields: entry.changedFields || null,
    previous_status: entry.previousStatus || null,
    new_status: entry.newStatus || null,
    created_at: nowIso()
  };

  if (!usePostgres) {
    const audits = readJsonArray(auditPath);
    const nextId = audits.length ? audits[0].id + 1 : 1;
    audits.unshift({ id: nextId, ...payload });
    writeJsonArray(auditPath, audits);
    return;
  }

  await pool.query(
    `
      INSERT INTO inquiry_audit (inquiry_id, action, changed_fields, previous_status, new_status, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [
      payload.inquiry_id,
      payload.action,
      payload.changed_fields ? JSON.stringify(payload.changed_fields) : null,
      payload.previous_status,
      payload.new_status,
      payload.created_at
    ]
  );
}

async function addInquiry(inquiry) {
  if (!usePostgres) {
    const items = readJsonArray(dbPath);
    const nextId = items.length ? items[0].id + 1 : 1;
    const row = {
      id: nextId,
      full_name: inquiry.fullName,
      company: inquiry.company,
      email: inquiry.email,
      request_type: inquiry.requestType,
      details: inquiry.details,
      status: "new",
      attachment_original_name: inquiry.attachmentOriginalName,
      attachment_stored_name: inquiry.attachmentStoredName,
      attachment_mime_type: inquiry.attachmentMimeType,
      attachment_size: inquiry.attachmentSize,
      created_at: inquiry.createdAt,
      updated_at: inquiry.createdAt
    };

    items.unshift(row);
    writeJsonArray(dbPath, items);
    return row;
  }

  const result = await pool.query(
    `
      INSERT INTO inquiries (
        full_name,
        company,
        email,
        request_type,
        details,
        status,
        attachment_original_name,
        attachment_stored_name,
        attachment_mime_type,
        attachment_size,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, 'new', $6, $7, $8, $9, $10, $11)
      RETURNING *
    `,
    [
      inquiry.fullName,
      inquiry.company || null,
      inquiry.email,
      inquiry.requestType,
      inquiry.details,
      inquiry.attachmentOriginalName,
      inquiry.attachmentStoredName,
      inquiry.attachmentMimeType,
      inquiry.attachmentSize,
      inquiry.createdAt,
      inquiry.createdAt
    ]
  );

  return result.rows[0];
}

function queueInquiryBacklog(payload, errorMessage) {
  const items = readJsonArray(inquiryBacklogPath);
  const nextId = items.length ? Math.max(...items.map((item) => Number(item.id) || 0)) + 1 : 1;

  const row = {
    id: nextId,
    payload,
    attempts: 0,
    queued_at: nowIso(),
    last_attempt_at: null,
    last_error: errorMessage || null
  };

  items.push(row);
  writeJsonArray(inquiryBacklogPath, items);
  monitorState.backlogPending = items.length;
  return row;
}

async function flushInquiryBacklog(maxItems = 25) {
  const queue = readJsonArray(inquiryBacklogPath);
  if (!queue.length) {
    monitorState.backlogPending = 0;
    return { flushed: 0, attempted: 0, remaining: 0 };
  }

  const remaining = [];
  let flushed = 0;
  let attempted = 0;

  for (let i = 0; i < queue.length; i += 1) {
    const item = queue[i];

    if (attempted >= maxItems) {
      remaining.push(item);
      continue;
    }

    attempted += 1;

    try {
      const savedRow = await addInquiry(item.payload);

      await addAuditEntry({
        inquiryId: savedRow.id,
        action: "create-from-backlog",
        newStatus: "new",
        changedFields: {
          backlog_id: item.id,
          has_attachment: Boolean(savedRow.attachment_stored_name)
        }
      });

      void notifyNewInquiry(savedRow);
      flushed += 1;
    } catch (error) {
      const failedItem = {
        ...item,
        attempts: Number(item.attempts || 0) + 1,
        last_attempt_at: nowIso(),
        last_error: error && error.message ? error.message : "Failed to flush backlog item"
      };

      remaining.push(failedItem);

      for (let j = i + 1; j < queue.length; j += 1) {
        remaining.push(queue[j]);
      }

      monitorState.lastBacklogFlushError = failedItem.last_error;
      break;
    }
  }

  writeJsonArray(inquiryBacklogPath, remaining);
  monitorState.backlogPending = remaining.length;
  monitorState.lastBacklogFlushAt = nowIso();
  if (!remaining.length || flushed > 0) {
    monitorState.lastBacklogFlushError = null;
  }

  return {
    flushed,
    attempted,
    remaining: remaining.length
  };
}

function matchesFilters(row, filters) {
  if (filters.q) {
    const term = filters.q.toLowerCase();
    const haystack = [row.full_name, row.company, row.email, row.request_type, row.details].join(" ").toLowerCase();
    if (!haystack.includes(term)) {
      return false;
    }
  }

  if (filters.email && !String(row.email || "").toLowerCase().includes(filters.email.toLowerCase())) {
    return false;
  }

  if (filters.requestType && row.request_type !== filters.requestType) {
    return false;
  }

  if (filters.status && row.status !== filters.status) {
    return false;
  }

  if (filters.dateFrom && new Date(row.created_at) < new Date(filters.dateFrom)) {
    return false;
  }

  if (filters.dateTo) {
    const to = new Date(filters.dateTo);
    to.setHours(23, 59, 59, 999);
    if (new Date(row.created_at) > to) {
      return false;
    }
  }

  return true;
}

async function listInquiries(filters = {}) {
  const { page, pageSize } = parsePagination(filters);

  if (!usePostgres) {
    const items = readJsonArray(dbPath);
    const filtered = items.filter((item) => matchesFilters(item, filters));
    const total = filtered.length;
    const start = (page - 1) * pageSize;
    const paged = filtered.slice(start, start + pageSize);

    return {
      rows: paged,
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize))
    };
  }

  const where = [];
  const params = [];

  if (filters.q) {
    params.push(normalizeLikeValue(filters.q));
    const i = params.length;
    where.push(`(LOWER(full_name) LIKE $${i} OR LOWER(company) LIKE $${i} OR LOWER(email) LIKE $${i} OR LOWER(request_type) LIKE $${i} OR LOWER(details) LIKE $${i})`);
  }

  if (filters.email) {
    params.push(normalizeLikeValue(filters.email));
    where.push(`LOWER(email) LIKE $${params.length}`);
  }

  if (filters.requestType) {
    params.push(filters.requestType);
    where.push(`request_type = $${params.length}`);
  }

  if (filters.status) {
    params.push(filters.status);
    where.push(`status = $${params.length}`);
  }

  if (filters.dateFrom) {
    params.push(filters.dateFrom);
    where.push(`created_at >= $${params.length}`);
  }

  if (filters.dateTo) {
    const to = new Date(filters.dateTo);
    to.setHours(23, 59, 59, 999);
    params.push(to.toISOString());
    where.push(`created_at <= $${params.length}`);
  }

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM inquiries ${whereClause}`, params);
  const total = countResult.rows[0]?.total || 0;

  params.push(pageSize);
  params.push((page - 1) * pageSize);
  const limitParam = params.length - 1;
  const offsetParam = params.length;

  const listQuery = `
    SELECT
      id,
      full_name,
      company,
      email,
      request_type,
      details,
      status,
      attachment_original_name,
      attachment_stored_name,
      attachment_mime_type,
      attachment_size,
      created_at,
      updated_at
    FROM inquiries
    ${whereClause}
    ORDER BY created_at DESC, id DESC
    LIMIT $${limitParam} OFFSET $${offsetParam}
  `;

  const rowsResult = await pool.query(listQuery, params);

  return {
    rows: rowsResult.rows,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize))
  };
}

async function getInquiryById(id) {
  if (!usePostgres) {
    const items = readJsonArray(dbPath);
    return items.find((item) => item.id === id) || null;
  }

  const result = await pool.query(
    `
      SELECT
        id,
        full_name,
        company,
        email,
        request_type,
        details,
        status,
        attachment_original_name,
        attachment_stored_name,
        attachment_mime_type,
        attachment_size,
        created_at,
        updated_at
      FROM inquiries
      WHERE id = $1
      LIMIT 1
    `,
    [id]
  );

  return result.rows[0] || null;
}

async function updateInquiryRecord(id, updates) {
  const existing = await getInquiryById(id);
  if (!existing) {
    return null;
  }

  const next = {
    full_name: updates.fullName || existing.full_name,
    company: updates.company || existing.company || "",
    email: updates.email || existing.email,
    request_type: updates.requestType || existing.request_type,
    details: updates.details || existing.details,
    status: updates.status ? sanitizeStatus(updates.status) : sanitizeStatus(existing.status),
    updated_at: nowIso()
  };

  const changedFields = {};
  ["full_name", "company", "email", "request_type", "details", "status"].forEach((key) => {
    if ((existing[key] || "") !== (next[key] || "")) {
      changedFields[key] = { before: existing[key], after: next[key] };
    }
  });

  if (!usePostgres) {
    const items = readJsonArray(dbPath);
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) {
      return null;
    }

    items[index] = {
      ...items[index],
      ...next
    };

    writeJsonArray(dbPath, items);

    await addAuditEntry({
      inquiryId: id,
      action: "update",
      changedFields,
      previousStatus: existing.status,
      newStatus: next.status
    });

    return items[index];
  }

  const result = await pool.query(
    `
      UPDATE inquiries
      SET
        full_name = $1,
        company = $2,
        email = $3,
        request_type = $4,
        details = $5,
        status = $6,
        updated_at = $7
      WHERE id = $8
      RETURNING *
    `,
    [
      next.full_name,
      next.company || null,
      next.email,
      next.request_type,
      next.details,
      next.status,
      next.updated_at,
      id
    ]
  );

  await addAuditEntry({
    inquiryId: id,
    action: "update",
    changedFields,
    previousStatus: existing.status,
    newStatus: next.status
  });

  return result.rows[0] || null;
}

async function updateInquiryStatus(id, status) {
  const sanitized = sanitizeStatus(status);
  const existing = await getInquiryById(id);

  if (!existing) {
    return null;
  }

  if (!usePostgres) {
    const items = readJsonArray(dbPath);
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) {
      return null;
    }

    items[index].status = sanitized;
    items[index].updated_at = nowIso();
    writeJsonArray(dbPath, items);

    await addAuditEntry({
      inquiryId: id,
      action: "status-change",
      previousStatus: existing.status,
      newStatus: sanitized,
      changedFields: { status: { before: existing.status, after: sanitized } }
    });

    return items[index];
  }

  const result = await pool.query(
    `
      UPDATE inquiries
      SET status = $1, updated_at = $2
      WHERE id = $3
      RETURNING *
    `,
    [sanitized, nowIso(), id]
  );

  await addAuditEntry({
    inquiryId: id,
    action: "status-change",
    previousStatus: existing.status,
    newStatus: sanitized,
    changedFields: { status: { before: existing.status, after: sanitized } }
  });

  return result.rows[0] || null;
}

async function deleteInquiry(id) {
  const existing = await getInquiryById(id);
  if (!existing) {
    return false;
  }

  if (!usePostgres) {
    const items = readJsonArray(dbPath);
    const filtered = items.filter((item) => item.id !== id);
    writeJsonArray(dbPath, filtered);

    await addAuditEntry({
      inquiryId: id,
      action: "delete",
      previousStatus: existing.status,
      changedFields: { deleted: true }
    });

    if (existing.attachment_stored_name) {
      const filePath = path.join(uploadsDir, existing.attachment_stored_name);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    return true;
  }

  await pool.query("DELETE FROM inquiries WHERE id = $1", [id]);

  await addAuditEntry({
    inquiryId: id,
    action: "delete",
    previousStatus: existing.status,
    changedFields: { deleted: true }
  });

  if (existing.attachment_stored_name) {
    const filePath = path.join(uploadsDir, existing.attachment_stored_name);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  return true;
}

async function listAudit(limit = 100) {
  if (!usePostgres) {
    const items = readJsonArray(auditPath);
    return items.slice(0, limit);
  }

  const result = await pool.query(
    `
      SELECT id, inquiry_id, action, changed_fields, previous_status, new_status, created_at
      FROM inquiry_audit
      ORDER BY created_at DESC, id DESC
      LIMIT $1
    `,
    [limit]
  );

  return result.rows;
}

async function getAnalytics() {
  if (!usePostgres) {
    const items = readJsonArray(dbPath);
    const totals = {
      total: items.length,
      byStatus: { new: 0, "in-progress": 0, resolved: 0 },
      byType: {}
    };
    const trendMap = {};

    for (const row of items) {
      totals.byStatus[sanitizeStatus(row.status)] += 1;
      totals.byType[row.request_type] = (totals.byType[row.request_type] || 0) + 1;

      const day = new Date(row.created_at).toISOString().slice(0, 10);
      trendMap[day] = (trendMap[day] || 0) + 1;
    }

    const trend = Object.entries(trendMap)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .slice(-14)
      .map(([date, count]) => ({ date, count }));

    return { ...totals, trend };
  }

  const totalResult = await pool.query("SELECT COUNT(*)::int AS total FROM inquiries");
  const statusResult = await pool.query("SELECT status, COUNT(*)::int AS count FROM inquiries GROUP BY status");
  const typeResult = await pool.query("SELECT request_type, COUNT(*)::int AS count FROM inquiries GROUP BY request_type");
  const trendResult = await pool.query(
    `
      SELECT TO_CHAR(created_at::date, 'YYYY-MM-DD') AS date, COUNT(*)::int AS count
      FROM inquiries
      WHERE created_at >= NOW() - INTERVAL '14 days'
      GROUP BY created_at::date
      ORDER BY created_at::date ASC
    `
  );

  const byStatus = { new: 0, "in-progress": 0, resolved: 0 };
  for (const row of statusResult.rows) {
    byStatus[sanitizeStatus(row.status)] = row.count;
  }

  const byType = {};
  for (const row of typeResult.rows) {
    byType[row.request_type] = row.count;
  }

  return {
    total: totalResult.rows[0]?.total || 0,
    byStatus,
    byType,
    trend: trendResult.rows
  };
}

async function runBackup(reason = "scheduled") {
  ensureDir(backupsDir);

  const snapshot = await listInquiries({ page: 1, pageSize: 10000 });
  const rows = snapshot.rows;
  const timestamp = nowIso().replace(/[:.]/g, "-");
  const jsonFile = path.join(backupsDir, `inquiries-${timestamp}.json`);
  const csvFile = path.join(backupsDir, `inquiries-${timestamp}.csv`);

  fs.writeFileSync(jsonFile, JSON.stringify(rows, null, 2), "utf8");
  fs.writeFileSync(csvFile, toInquiriesCsv(rows), "utf8");

  monitorState.lastBackupAt = nowIso();
  monitorState.lastBackupError = null;

  await addAuditEntry({
    action: "backup",
    changedFields: { reason, jsonFile: path.basename(jsonFile), csvFile: path.basename(csvFile), rows: rows.length }
  });
}

function toPublicUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    created_at: user.created_at
  };
}

function signUserToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      email: user.email
    },
    AUTH_JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    return "";
  }

  return header.slice(7).trim();
}

async function findUserById(id) {
  if (!usePostgres) {
    const users = readJsonArray(usersPath);
    return users.find((item) => item.id === id) || null;
  }

  const result = await pool.query(
    `
      SELECT id, username, email, password_hash, created_at
      FROM users
      WHERE id = $1
      LIMIT 1
    `,
    [id]
  );

  return result.rows[0] || null;
}

async function findUserByIdentity(identity) {
  const normalized = String(identity || "").trim().toLowerCase();

  if (!normalized) {
    return null;
  }

  if (!usePostgres) {
    const users = readJsonArray(usersPath);
    return users.find((item) => item.username.toLowerCase() === normalized || item.email.toLowerCase() === normalized) || null;
  }

  const result = await pool.query(
    `
      SELECT id, username, email, password_hash, created_at
      FROM users
      WHERE LOWER(username) = $1 OR LOWER(email) = $1
      LIMIT 1
    `,
    [normalized]
  );

  return result.rows[0] || null;
}

async function createUserAccount({ username, email, passwordHash }) {
  const normalizedUsername = String(username || "").trim();
  const normalizedEmail = String(email || "").trim().toLowerCase();

  if (!usePostgres) {
    const users = readJsonArray(usersPath);
    const existing = users.find((item) => item.username.toLowerCase() === normalizedUsername.toLowerCase() || item.email.toLowerCase() === normalizedEmail);

    if (existing) {
      return null;
    }

    const nextId = users.length ? users[0].id + 1 : 1;
    const row = {
      id: nextId,
      username: normalizedUsername,
      email: normalizedEmail,
      password_hash: passwordHash,
      created_at: nowIso()
    };

    users.unshift(row);
    writeJsonArray(usersPath, users);
    return row;
  }

  const result = await pool.query(
    `
      INSERT INTO users (username, email, password_hash)
      VALUES ($1, $2, $3)
      ON CONFLICT DO NOTHING
      RETURNING id, username, email, password_hash, created_at
    `,
    [normalizedUsername, normalizedEmail, passwordHash]
  );

  return result.rows[0] || null;
}

async function ensureStarterProject(userId) {
  if (!usePostgres) {
    const projects = readJsonArray(userProgressPath);
    const exists = projects.some((item) => item.user_id === userId);

    if (exists) {
      return;
    }

    const nextId = projects.length ? projects[0].id + 1 : 1;
    projects.unshift({
      id: nextId,
      user_id: userId,
      project_name: "Initial Discovery",
      status: "Planning",
      percent_complete: 15,
      deadline_date: new Date(Date.now() + 1000 * 60 * 60 * 24 * 56).toISOString().slice(0, 10),
      budget_total: 12000,
      budget_used: 1800,
      summary: "Requirements collected and project timeline drafted.",
      updated_at: nowIso()
    });

    writeJsonArray(userProgressPath, projects);
    return;
  }

  const existing = await pool.query("SELECT id FROM user_project_progress WHERE user_id = $1 LIMIT 1", [userId]);
  if (existing.rows[0]) {
    return;
  }

  await pool.query(
    `
      INSERT INTO user_project_progress (
        user_id,
        project_name,
        status,
        percent_complete,
        deadline_date,
        budget_total,
        budget_used,
        summary,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    `,
    [
      userId,
      "Initial Discovery",
      "Planning",
      15,
      "Requirements collected and project timeline drafted.",
      new Date(Date.now() + 1000 * 60 * 60 * 24 * 56).toISOString().slice(0, 10),
      12000,
      1800
    ]
  );
}

async function listUserProjects(userId) {
  if (!usePostgres) {
    const projects = readJsonArray(userProgressPath);
    return projects
      .filter((item) => item.user_id === userId)
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  }

  const result = await pool.query(
    `
      SELECT id, user_id, project_name, status, percent_complete, summary, updated_at
      , deadline_date, budget_total, budget_used
      FROM user_project_progress
      WHERE user_id = $1
      ORDER BY updated_at DESC, id DESC
    `,
    [userId]
  );

  return result.rows;
}

async function upsertUserProjectProgress({ userId, projectName, status, percentComplete, summary, deadlineDate, budgetTotal, budgetUsed }) {
  const safePercent = Math.max(0, Math.min(100, Number(percentComplete || 0)));
  const nextStatus = String(status || "Planning").trim() || "Planning";
  const nextSummary = String(summary || "").trim() || "Progress updated.";
  const nextProjectName = String(projectName || "").trim() || "Project";
  const nextDeadlineDate = String(deadlineDate || "").trim() || null;
  const safeBudgetTotal = Number.isFinite(Number(budgetTotal)) ? Math.max(0, Number(budgetTotal)) : 0;
  const safeBudgetUsed = Number.isFinite(Number(budgetUsed)) ? Math.max(0, Number(budgetUsed)) : 0;

  if (!usePostgres) {
    const items = readJsonArray(userProgressPath);
    const existingIndex = items.findIndex((item) => item.user_id === userId && item.project_name.toLowerCase() === nextProjectName.toLowerCase());

    if (existingIndex === -1) {
      const nextId = items.length ? items[0].id + 1 : 1;
      const row = {
        id: nextId,
        user_id: userId,
        project_name: nextProjectName,
        status: nextStatus,
        percent_complete: safePercent,
        deadline_date: nextDeadlineDate,
        budget_total: safeBudgetTotal,
        budget_used: safeBudgetUsed,
        summary: nextSummary,
        updated_at: nowIso()
      };
      items.unshift(row);
      writeJsonArray(userProgressPath, items);
      return row;
    }

    items[existingIndex] = {
      ...items[existingIndex],
      status: nextStatus,
      percent_complete: safePercent,
      deadline_date: nextDeadlineDate,
      budget_total: safeBudgetTotal,
      budget_used: safeBudgetUsed,
      summary: nextSummary,
      updated_at: nowIso()
    };

    writeJsonArray(userProgressPath, items);
    return items[existingIndex];
  }

  const existing = await pool.query(
    `
      SELECT id
      FROM user_project_progress
      WHERE user_id = $1 AND LOWER(project_name) = LOWER($2)
      LIMIT 1
    `,
    [userId, nextProjectName]
  );

  if (!existing.rows[0]) {
    const insertResult = await pool.query(
      `
        INSERT INTO user_project_progress (
          user_id,
          project_name,
          status,
          percent_complete,
          deadline_date,
          budget_total,
          budget_used,
          summary,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        RETURNING id, user_id, project_name, status, percent_complete, deadline_date, budget_total, budget_used, summary, updated_at
      `,
      [userId, nextProjectName, nextStatus, safePercent, nextDeadlineDate, safeBudgetTotal, safeBudgetUsed, nextSummary]
    );

    return insertResult.rows[0];
  }

  const updateResult = await pool.query(
    `
      UPDATE user_project_progress
      SET status = $1, percent_complete = $2, deadline_date = $3, budget_total = $4, budget_used = $5, summary = $6, updated_at = NOW()
      WHERE id = $7
      RETURNING id, user_id, project_name, status, percent_complete, deadline_date, budget_total, budget_used, summary, updated_at
    `,
    [nextStatus, safePercent, nextDeadlineDate, safeBudgetTotal, safeBudgetUsed, nextSummary, existing.rows[0].id]
  );

  return updateResult.rows[0];
}

async function requireUser(req, res, next) {
  const token = getBearerToken(req);

  if (!token) {
    return res.status(401).json({ ok: false, message: "Authentication required." });
  }

  try {
    const decoded = jwt.verify(token, AUTH_JWT_SECRET);
    const userId = Number(decoded.sub);
    const user = await findUserById(userId);

    if (!user) {
      return res.status(401).json({ ok: false, message: "Invalid authentication token." });
    }

    req.authUser = user;
    return next();
  } catch (_error) {
    return res.status(401).json({ ok: false, message: "Invalid authentication token." });
  }
}

async function checkStorageHealth() {
  try {
    if (usePostgres) {
      await pool.query("SELECT 1");
    } else {
      readJsonArray(dbPath);
    }

    const wasHealthy = monitorState.storageHealthy;
    monitorState.storageHealthy = true;
    monitorState.lastStorageCheckAt = nowIso();
    monitorState.lastStorageError = null;

    if (!wasHealthy) {
      await sendMonitoringAlert(true, "Storage connectivity has recovered.");
    }
  } catch (error) {
    const wasHealthy = monitorState.storageHealthy;
    monitorState.storageHealthy = false;
    monitorState.lastStorageCheckAt = nowIso();
    monitorState.lastStorageError = error.message;

    if (wasHealthy) {
      await sendMonitoringAlert(false, `Storage health check failed: ${error.message}`);
    }
  }
}

const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    message: "Too many requests from this IP. Please try again shortly."
  }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    message: "Too many authentication attempts. Please try again later."
  }
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      ensureDir(uploadsDir);
      cb(null, uploadsDir);
    },
    filename: (_req, file, cb) => {
      const extension = path.extname(file.originalname || "");
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`);
    }
  }),
  limits: {
    fileSize: 5 * 1024 * 1024
  },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "application/pdf",
      "image/png",
      "image/jpeg",
      "text/plain",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ];

    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Unsupported file type"));
    }

    return cb(null, true);
  }
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(__dirname));

if (!ADMIN_KEY) {
  console.warn("ADMIN_KEY is not set. Admin endpoints will be unavailable until configured.");
}

if (!process.env.AUTH_JWT_SECRET) {
  console.warn("AUTH_JWT_SECRET is not set. Configure a strong secret for production account security.");
}

if (trustProxySetting) {
  console.log(`Express trust proxy enabled: ${String(trustProxySetting)}`);
}

app.get("/health", (_req, res) => {
  return res.status(200).json({ ok: true });
});

app.get("/health/details", (_req, res) => {
  return res.status(200).json({
    ok: monitorState.storageHealthy,
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    storage_mode: usePostgres ? "postgres" : "json",
    storage_healthy: monitorState.storageHealthy,
    last_storage_check_at: monitorState.lastStorageCheckAt,
    last_storage_error: monitorState.lastStorageError,
    backlog_pending: monitorState.backlogPending,
    last_backlog_flush_at: monitorState.lastBacklogFlushAt,
    last_backlog_flush_error: monitorState.lastBacklogFlushError,
    last_backup_at: monitorState.lastBackupAt,
    last_backup_error: monitorState.lastBackupError,
    last_alert_at: monitorState.lastAlertAt
  });
});

app.get("/admin", (_req, res) => {
  return res.redirect("/admin.html");
});

app.get("/account", (_req, res) => {
  return res.redirect("/account.html");
});

app.post("/api/auth/register", authLimiter, async (req, res) => {
  const username = String(req.body.username || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  if (!username || !email || !password) {
    return res.status(400).json({ ok: false, message: "Username, email, and password are required." });
  }

  if (username.length < 3 || username.length > 32) {
    return res.status(400).json({ ok: false, message: "Username must be 3-32 characters." });
  }

  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) {
    return res.status(400).json({ ok: false, message: "Username may include letters, numbers, underscore, hyphen, and dot." });
  }

  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ ok: false, message: "Please enter a valid email address." });
  }

  if (password.length < 8) {
    return res.status(400).json({ ok: false, message: "Password must be at least 8 characters." });
  }

  try {
    const existing = await findUserByIdentity(username) || await findUserByIdentity(email);
    if (existing) {
      return res.status(409).json({ ok: false, message: "An account with this username or email already exists." });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await createUserAccount({ username, email, passwordHash });

    if (!user) {
      return res.status(409).json({ ok: false, message: "Unable to create account with these details." });
    }

    await ensureStarterProject(user.id);

    const token = signUserToken(user);
    return res.json({ ok: true, token, user: toPublicUser(user) });
  } catch (error) {
    console.error("Failed to register user", error);
    return res.status(500).json({ ok: false, message: "Unable to create account right now." });
  }
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  const identity = String(req.body.identity || req.body.username || req.body.email || "").trim();
  const password = String(req.body.password || "");

  if (!identity || !password) {
    return res.status(400).json({ ok: false, message: "Username/email and password are required." });
  }

  try {
    const user = await findUserByIdentity(identity);

    if (!user) {
      return res.status(401).json({ ok: false, message: "Invalid login credentials." });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ ok: false, message: "Invalid login credentials." });
    }

    const token = signUserToken(user);
    return res.json({ ok: true, token, user: toPublicUser(user) });
  } catch (error) {
    console.error("Failed to login user", error);
    return res.status(500).json({ ok: false, message: "Unable to login right now." });
  }
});

app.get("/api/auth/me", requireUser, async (req, res) => {
  return res.json({ ok: true, user: toPublicUser(req.authUser) });
});

app.get("/api/user/progress", requireUser, async (req, res) => {
  try {
    const projects = await listUserProjects(req.authUser.id);
    return res.json({ ok: true, projects });
  } catch (error) {
    console.error("Failed to load user progress", error);
    return res.status(500).json({ ok: false, message: "Unable to load project progress right now." });
  }
});

app.post("/api/admin/user-progress", requireAdmin, async (req, res) => {
  const identity = String(req.body.identity || req.body.username || req.body.email || "").trim();
  const projectName = String(req.body.projectName || "").trim();
  const status = String(req.body.status || "").trim();
  const summary = String(req.body.summary || "").trim();
  const percentComplete = Number(req.body.percentComplete);
  const deadlineDate = String(req.body.deadlineDate || "").trim();
  const budgetTotal = Number(req.body.budgetTotal);
  const budgetUsed = Number(req.body.budgetUsed);

  if (!identity || !projectName || !summary || !Number.isFinite(percentComplete)) {
    return res.status(400).json({
      ok: false,
      message: "identity, projectName, summary, and percentComplete are required."
    });
  }

  try {
    const user = await findUserByIdentity(identity);
    if (!user) {
      return res.status(404).json({ ok: false, message: "User not found." });
    }

    const project = await upsertUserProjectProgress({
      userId: user.id,
      projectName,
      status,
      percentComplete,
      summary,
      deadlineDate,
      budgetTotal,
      budgetUsed
    });

    await addAuditEntry({
      action: "user-progress-upsert",
      changedFields: {
        user_id: user.id,
        project_name: project.project_name,
        percent_complete: project.percent_complete
      }
    });

    return res.json({ ok: true, project });
  } catch (error) {
    console.error("Failed to upsert user project progress", error);
    return res.status(500).json({ ok: false, message: "Unable to update user project progress right now." });
  }
});

app.post("/api/admin/users/reset", requireAdmin, async (_req, res) => {
  try {
    if (!usePostgres) {
      writeJsonArray(usersPath, []);
      writeJsonArray(userProgressPath, []);
    } else {
      await pool.query("TRUNCATE TABLE user_project_progress, users RESTART IDENTITY CASCADE");
    }

    await addAuditEntry({
      action: "users-reset",
      changedFields: { reset_all_accounts: true }
    });

    return res.json({ ok: true });
  } catch (error) {
    console.error("Failed to reset user accounts", error);
    return res.status(500).json({ ok: false, message: "Unable to reset accounts right now." });
  }
});

app.get("/api/admin/inquiries/backlog", requireAdmin, async (_req, res) => {
  try {
    const queue = readJsonArray(inquiryBacklogPath);
    const oldest = queue.length ? queue[0] : null;

    monitorState.backlogPending = queue.length;

    return res.json({
      ok: true,
      backlog: {
        pending: queue.length,
        oldestQueuedAt: oldest ? oldest.queued_at : null,
        lastFlushAt: monitorState.lastBacklogFlushAt,
        lastFlushError: monitorState.lastBacklogFlushError
      }
    });
  } catch (error) {
    console.error("Failed to read inquiry backlog status", error);
    return res.status(500).json({ ok: false, message: "Unable to read inquiry backlog status." });
  }
});

app.post("/api/admin/inquiries/backlog/flush", requireAdmin, async (req, res) => {
  const requestedLimit = Number(req.body.limit);
  const limit = Number.isFinite(requestedLimit) ? Math.min(500, Math.max(1, Math.floor(requestedLimit))) : 100;

  try {
    const result = await flushInquiryBacklog(limit);

    await addAuditEntry({
      action: "backlog-flush-manual",
      changedFields: {
        attempted: result.attempted,
        flushed: result.flushed,
        remaining: result.remaining
      }
    });

    return res.json({ ok: true, result });
  } catch (error) {
    console.error("Failed to flush inquiry backlog", error);
    return res.status(500).json({ ok: false, message: "Unable to flush inquiry backlog right now." });
  }
});

app.post("/api/inquiries", contactLimiter, (req, res, next) => {
  upload.single("attachment")(req, res, (err) => {
    if (err) {
      return res.status(400).json({
        ok: false,
        message: err.message || "Attachment upload failed."
      });
    }

    return next();
  });
}, async (req, res) => {
  const fullName = (req.body["full-name"] || req.body.fullName || "").trim();
  const company = (req.body.company || "").trim();
  const email = (req.body.email || "").trim();
  const requestType = (req.body["service-type"] || req.body.requestType || "").trim();
  const details = (req.body.details || "").trim();
  const honeypot = (req.body.website || "").trim();

  if (honeypot) {
    return res.status(400).json({
      ok: false,
      message: "Spam submission rejected."
    });
  }

  if (!fullName || !email || !requestType || !details) {
    return res.status(400).json({
      ok: false,
      message: "Please complete all required fields."
    });
  }

  const createdAt = nowIso();
  const inquiryPayload = {
    fullName,
    company,
    email,
    requestType,
    details,
    createdAt,
    ...mapFileMeta(req.file)
  };

  try {
    const savedRow = await addInquiry(inquiryPayload);

    await addAuditEntry({
      inquiryId: savedRow.id,
      action: "create",
      newStatus: "new",
      changedFields: {
        request_type: savedRow.request_type,
        has_attachment: Boolean(savedRow.attachment_stored_name)
      }
    });

    void notifyNewInquiry(savedRow);

    return res.json({ ok: true });
  } catch (error) {
    console.error("Failed to save inquiry", error);

    try {
      const queued = queueInquiryBacklog(
        inquiryPayload,
        error && error.message ? error.message : "Primary storage unavailable"
      );

      return res.status(202).json({
        ok: true,
        queued: true,
        backlogId: queued.id,
        message: "Request queued safely. It will be submitted automatically when service is available."
      });
    } catch (queueError) {
      console.error("Failed to queue inquiry in backlog", queueError);
    }

    return res.status(500).json({
      ok: false,
      message: "Unable to save inquiry right now."
    });
  }
});

app.get("/api/inquiries", requireAdmin, async (req, res) => {
  try {
    const result = await listInquiries({
      q: (req.query.q || "").toString().trim(),
      email: (req.query.email || "").toString().trim(),
      requestType: (req.query.requestType || "").toString().trim(),
      status: sanitizeStatus((req.query.status || "").toString().trim()),
      dateFrom: (req.query.dateFrom || "").toString().trim(),
      dateTo: (req.query.dateTo || "").toString().trim(),
      page: Number(req.query.page || 1),
      pageSize: Number(req.query.pageSize || 25)
    });

    return res.json({
      ok: true,
      inquiries: result.rows,
      pagination: {
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        totalPages: result.totalPages
      }
    });
  } catch (error) {
    console.error("Failed to read inquiries", error);
    return res.status(500).json({
      ok: false,
      message: "Unable to load inquiries right now."
    });
  }
});

app.get("/api/inquiries.csv", requireAdmin, async (_req, res) => {
  try {
    const rows = (await listInquiries({ page: 1, pageSize: 10000 })).rows;
    const csv = toInquiriesCsv(rows);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=Horizon-inquiries.csv");
    return res.status(200).send(csv);
  } catch (error) {
    console.error("Failed to export inquiries CSV", error);
    return res.status(500).json({
      ok: false,
      message: "Unable to export inquiries right now."
    });
  }
});

app.get("/api/inquiries/analytics", requireAdmin, async (_req, res) => {
  try {
    const analytics = await getAnalytics();
    return res.json({ ok: true, analytics });
  } catch (error) {
    console.error("Failed to load analytics", error);
    return res.status(500).json({ ok: false, message: "Unable to load analytics." });
  }
});

app.get("/api/inquiries/audit", requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const items = await listAudit(limit);
    return res.json({ ok: true, audit: items });
  } catch (error) {
    console.error("Failed to load audit log", error);
    return res.status(500).json({ ok: false, message: "Unable to load audit log." });
  }
});

app.get("/api/inquiries/:id/attachment", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ ok: false, message: "Invalid inquiry id." });
  }

  try {
    const inquiry = await getInquiryById(id);

    if (!inquiry || !inquiry.attachment_stored_name) {
      return res.status(404).json({ ok: false, message: "Attachment not found." });
    }

    const filePath = path.join(uploadsDir, inquiry.attachment_stored_name);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ ok: false, message: "Attachment file missing." });
    }

    return res.download(filePath, inquiry.attachment_original_name || "attachment");
  } catch (error) {
    console.error("Failed to load attachment", error);
    return res.status(500).json({ ok: false, message: "Unable to load attachment." });
  }
});

app.patch("/api/inquiries/:id/status", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ ok: false, message: "Invalid inquiry id." });
  }

  const status = sanitizeStatus((req.body.status || "").toString().trim());

  try {
    const row = await updateInquiryStatus(id, status);

    if (!row) {
      return res.status(404).json({ ok: false, message: "Inquiry not found." });
    }

    return res.json({ ok: true, inquiry: row });
  } catch (error) {
    console.error("Failed to update inquiry status", error);
    return res.status(500).json({ ok: false, message: "Unable to update inquiry status." });
  }
});

app.patch("/api/inquiries/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ ok: false, message: "Invalid inquiry id." });
  }

  const updates = pickAllowedFieldsForEdit(req.body);
  if (!updates.fullName || !updates.email || !updates.requestType || !updates.details) {
    return res.status(400).json({ ok: false, message: "Name, email, type, and details are required." });
  }

  try {
    const row = await updateInquiryRecord(id, updates);

    if (!row) {
      return res.status(404).json({ ok: false, message: "Inquiry not found." });
    }

    return res.json({ ok: true, inquiry: row });
  } catch (error) {
    console.error("Failed to edit inquiry", error);
    return res.status(500).json({ ok: false, message: "Unable to edit inquiry." });
  }
});

app.delete("/api/inquiries/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ ok: false, message: "Invalid inquiry id." });
  }

  try {
    const removed = await deleteInquiry(id);

    if (!removed) {
      return res.status(404).json({ ok: false, message: "Inquiry not found." });
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error("Failed to delete inquiry", error);
    return res.status(500).json({ ok: false, message: "Unable to delete inquiry." });
  }
});

initStorage()
  .then(async () => {
    mailer = createMailer();

    await checkStorageHealth();
    monitorState.backlogPending = readJsonArray(inquiryBacklogPath).length;

    try {
      await flushInquiryBacklog(50);
    } catch (error) {
      monitorState.lastBacklogFlushError = error.message;
      console.error("Initial backlog flush failed", error);
    }

    try {
      await runBackup("startup");
    } catch (error) {
      monitorState.lastBackupError = error.message;
      console.error("Initial backup failed", error);
    }

    cron.schedule(BACKUP_CRON, async () => {
      try {
        await runBackup("scheduled");
      } catch (error) {
        monitorState.lastBackupError = error.message;
        console.error("Scheduled backup failed", error);
      }
    });

    cron.schedule(BACKLOG_FLUSH_CRON, async () => {
      try {
        await flushInquiryBacklog(50);
      } catch (error) {
        monitorState.lastBacklogFlushError = error.message;
        console.error("Scheduled backlog flush failed", error);
      }
    });

    console.log(`Backups scheduled with cron: ${BACKUP_CRON}`);
    console.log(`Backlog flush scheduled with cron: ${BACKLOG_FLUSH_CRON}`);
    console.log(`this web application was made via vibe coding, by a 17 year old with coding knowledge`);

    setInterval(() => {
      checkStorageHealth().catch((error) => {
        console.error("Health check interval failed", error);
      });
    }, 5 * 60 * 1000);

    app.listen(PORT, () => {
      console.log(`Horizon server running on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize storage", error);
    process.exit(1);
  });
