const path = require("path");
const fs = require("fs");
const express = require("express");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const nodemailer = require("nodemailer");
const cron = require("node-cron");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const usePostgres = Boolean(DATABASE_URL);
const startTime = Date.now();

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
const uploadsDir = path.join(__dirname, "uploads");
const backupsDir = path.join(__dirname, "backups");

let pool = null;
let mailer = null;

const monitorState = {
  storageHealthy: true,
  lastStorageCheckAt: null,
  lastStorageError: null,
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
    auth: {
      user: EMAIL_CONFIG.user,
      pass: EMAIL_CONFIG.pass
    }
  });
}

async function sendEmail({ to, subject, text }) {
  if (!mailer || !to) {
    return;
  }

  await mailer.sendMail({
    from: EMAIL_CONFIG.from,
    to,
    subject,
    text
  });
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

  try {
    await sendEmail({
      to: EMAIL_CONFIG.notifyTo,
      subject: `New Inquiry #${row.id} - ${row.request_type}`,
      text
    });
  } catch (error) {
    console.error("Failed to send inquiry notification email", error);
  }
}

async function sendMonitoringAlert(isHealthy, message) {
  if (!EMAIL_CONFIG.alertTo) {
    return;
  }

  try {
    await sendEmail({
      to: EMAIL_CONFIG.alertTo,
      subject: isHealthy ? "Horizon monitor recovered" : "Horizon monitor alert",
      text: `${message}\n\nTime: ${nowIso()}`
    });
    monitorState.lastAlertAt = nowIso();
  } catch (error) {
    console.error("Failed to send monitoring alert", error);
  }
}

async function initStorage() {
  ensureDir(uploadsDir);
  ensureDir(backupsDir);

  if (!usePostgres) {
    ensureJsonFile(dbPath, "[]");
    ensureJsonFile(auditPath, "[]");
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
    last_backup_at: monitorState.lastBackupAt,
    last_backup_error: monitorState.lastBackupError,
    last_alert_at: monitorState.lastAlertAt
  });
});

app.get("/admin", (_req, res) => {
  return res.redirect("/admin.html");
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

  try {
    const savedRow = await addInquiry({
      fullName,
      company,
      email,
      requestType,
      details,
      createdAt,
      ...mapFileMeta(req.file)
    });

    await addAuditEntry({
      inquiryId: savedRow.id,
      action: "create",
      newStatus: "new",
      changedFields: {
        request_type: savedRow.request_type,
        has_attachment: Boolean(savedRow.attachment_stored_name)
      }
    });

    await notifyNewInquiry(savedRow);

    return res.json({ ok: true });
  } catch (error) {
    console.error("Failed to save inquiry", error);
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

    try {
      await runBackup("startup");
    } catch (error) {
      monitorState.lastBackupError = error.message;
      console.error("Initial backup failed", error);
    }

    cron.schedule("0 2 * * *", async () => {
      try {
        await runBackup("daily");
      } catch (error) {
        monitorState.lastBackupError = error.message;
        console.error("Scheduled backup failed", error);
      }
    });

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
