const path = require("path");
const fs = require("fs");
const express = require("express");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const usePostgres = Boolean(DATABASE_URL);
let pool = null;

const dbPath = path.join(__dirname, "inquiries.json");

function ensureDbFile() {
  if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, "[]", "utf8");
  }
}

function readInquiries() {
  ensureDbFile();
  const raw = fs.readFileSync(dbPath, "utf8");
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeInquiries(items) {
  fs.writeFileSync(dbPath, JSON.stringify(items, null, 2), "utf8");
}

async function initStorage() {
  if (!usePostgres) {
    ensureDbFile();
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  console.log("Using PostgreSQL storage for inquiries.");
}

async function addInquiry(inquiry) {
  if (!usePostgres) {
    const inquiries = readInquiries();
    const nextId = inquiries.length ? inquiries[0].id + 1 : 1;

    inquiries.unshift({
      id: nextId,
      full_name: inquiry.fullName,
      company: inquiry.company,
      email: inquiry.email,
      request_type: inquiry.requestType,
      details: inquiry.details,
      created_at: inquiry.createdAt
    });

    writeInquiries(inquiries);
    return;
  }

  await pool.query(
    `
      INSERT INTO inquiries (full_name, company, email, request_type, details, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [
      inquiry.fullName,
      inquiry.company || null,
      inquiry.email,
      inquiry.requestType,
      inquiry.details,
      inquiry.createdAt
    ]
  );
}

async function listInquiries() {
  if (!usePostgres) {
    return readInquiries();
  }

  const result = await pool.query(
    `
      SELECT id, full_name, company, email, request_type, details, created_at
      FROM inquiries
      ORDER BY created_at DESC, id DESC
    `
  );

  return result.rows;
}

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(__dirname));

if (!ADMIN_KEY) {
  console.warn("ADMIN_KEY is not set. /api/inquiries admin endpoint will be unavailable until it is configured.");
}

app.get("/health", (_req, res) => {
  return res.status(200).json({ ok: true });
});

app.get("/admin", (_req, res) => {
  return res.redirect("/admin.html");
});

app.post("/api/inquiries", async (req, res) => {
  const fullName = (req.body["full-name"] || req.body.fullName || "").trim();
  const company = (req.body.company || "").trim();
  const email = (req.body.email || "").trim();
  const requestType = (req.body["service-type"] || req.body.requestType || "").trim();
  const details = (req.body.details || "").trim();

  if (!fullName || !email || !requestType || !details) {
    return res.status(400).json({
      ok: false,
      message: "Please complete all required fields."
    });
  }

  try {
    await addInquiry({
      fullName,
      company,
      email,
      requestType,
      details,
      createdAt: new Date().toISOString()
    });

    return res.json({ ok: true });
  } catch (error) {
    console.error("Failed to save inquiry", error);
    return res.status(500).json({
      ok: false,
      message: "Unable to save inquiry right now."
    });
  }
});

app.get("/api/inquiries", async (req, res) => {
  if (!ADMIN_KEY) {
    return res.status(503).json({
      ok: false,
      message: "Admin endpoint is not configured. Set ADMIN_KEY on the server."
    });
  }

  const suppliedKey = req.query.key || req.headers["x-admin-key"];

  if (suppliedKey !== ADMIN_KEY) {
    return res.status(401).json({
      ok: false,
      message: "Unauthorized"
    });
  }

  try {
    const rows = await listInquiries();
    return res.json({ ok: true, inquiries: rows });
  } catch (error) {
    console.error("Failed to read inquiries", error);
    return res.status(500).json({
      ok: false,
      message: "Unable to load inquiries right now."
    });
  }
});

initStorage()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Horizon server running on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize storage", error);
    process.exit(1);
  });
