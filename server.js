// server.js — SpotAlert FULL backend (SQLite + AWS + Auth + Zones + Cost + S3 Snapshot Storage + Alerts Dashboard + Pin/Retention)
// ✅ S3 ONLY for images (alerts + known faces)
// ✅ Alerts API: list, image, delete, pin/unpin, retention (100 max, deletes oldest UNPINNED only)
// ✅ CCTV ingest: /api/cctv/:id/snapshot with X-Camera-Key
// ✅ Cameras: register/list/delete with JWT
// ✅ Locations/Zones/Zone Rules: active
// ✅ Usage summary (JWT) + Plans
// ✅ Stripe checkout session endpoint (JWT)
// ✅ Timezone/log-event persisted (NOT memory)
// ✅ SAFE DB migrations: adds missing tables/columns without crashing
// ✅ Does not crash server if AWS/SES/Stripe not configured (routes return clear errors)

import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import shiraRoutes from "./routes/shira.js";

// AWS SDK v3
import {
  RekognitionClient,
  SearchFacesByImageCommand,
  IndexFacesCommand,
  DeleteFacesCommand
} from "@aws-sdk/client-rekognition";

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand
} from "@aws-sdk/client-s3";

import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

// Stripe (optional)
import Stripe from "stripe";

dotenv.config();

const app = express();
app.set("trust proxy", 1);

// body parsing
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true }));

// CORS
const allowedOrigins = [
  process.env.FRONTEND_URL,
  "https://spotalert.live",
  "http://localhost:3000"
].filter(Boolean);

app.use(
  cors({
    origin: function (origin, cb) {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked: " + origin));
    },
    credentials: true
  })
);

// multer memory (images)
const upload = multer({ storage: multer.memoryStorage() });

// AWS clients (safe init)
const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const rekognition = new RekognitionClient({ region: AWS_REGION });
const ses = new SESClient({ region: AWS_REGION });
const s3 = new S3Client({ region: AWS_REGION });

// Stripe (optional)
const stripe =
  process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY !== "REPLACE_ME"
    ? new Stripe(process.env.STRIPE_SECRET_KEY)
    : null;

// DB handle
let db;

// -------------------------
// Helpers
// -------------------------
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} missing`);
  return v;
}

function safeLower(s) {
  return String(s || "").toLowerCase().trim();
}

function nowIso() {
  return new Date().toISOString();
}

function monthKey(date = new Date()) {
  return date.toISOString().slice(0, 7); // YYYY-MM
}

function signToken(payload) {
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET missing");
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "30d" });
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { email, plan, ... }
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

function adminAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing admin token" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== "admin") throw new Error("Not admin");
    req.admin = decoded;
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid admin token" });
  }
}

function streamToRes(readable, res) {
  // readable is a Node stream
  readable.on("error", () => {
    try {
      res.status(500).end();
    } catch {}
  });
  readable.pipe(res);
}

function s3Bucket() {
  // allow both keys for compatibility
  return (
    process.env.S3_BUCKET ||
    process.env.S3_BUCKET_NAME ||
    process.env.S3_BUCKET_ALERTS ||
    ""
  );
}

function rekogCollection() {
  return process.env.REKOG_COLLECTION_ID || "";
}

function apiBase() {
  return process.env.API_BASE_URL || process.env.BASE_URL || "";
}

// -------------------------------------
// SAFE DB migration helpers
// -------------------------------------
async function tableExists(name) {
  const r = await db.get(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
    name
  );
  return !!r;
}

async function columnExists(table, column) {
  const cols = await db.all(`PRAGMA table_info(${table})`);
  return cols.some((c) => c.name === column);
}

async function ensureSchema() {
  // base tables
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'Free Trial',
      trial_end DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      reset_token TEXT,
      reset_expires DATETIME,
      email_verified INTEGER DEFAULT 1,
      disabled INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      price REAL,
      cameras INTEGER,
      scan_limit INTEGER
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_email TEXT NOT NULL,
      type TEXT NOT NULL,                  -- 'unknown' | 'known'
      image_key TEXT,                      -- S3 key
      channel TEXT NOT NULL DEFAULT 'email',
      cost REAL NOT NULL DEFAULT 0,
      zone_id INTEGER,
      camera_id INTEGER,
      pinned INTEGER NOT NULL DEFAULT 0,   -- 1 = keep/protect
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_email TEXT NOT NULL,
      name TEXT NOT NULL,
      address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS zones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      cost_per_scan REAL NOT NULL DEFAULT 0.001,
      active_hours TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS zone_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      zone_id INTEGER UNIQUE,
      rule_type TEXT NOT NULL DEFAULT 'unknown_only', -- known_only | unknown_only | mixed
      alert_interval INTEGER NOT NULL DEFAULT 10,      -- minutes
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS known_faces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_email TEXT NOT NULL,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS known_face_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      known_face_id INTEGER,
      face_id TEXT,     -- rekognition face id
      s3_key TEXT,      -- S3 key of training image
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS cameras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_email TEXT NOT NULL,
      name TEXT NOT NULL,
      location TEXT,
      ip TEXT,
      zone_id INTEGER,
      api_key TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS event_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_email TEXT,
      type TEXT NOT NULL,           -- 'timezone' | 'event'
      payload TEXT,                 -- JSON string
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS usage_costs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_email TEXT NOT NULL,
      property_id INTEGER NOT NULL,
      month TEXT NOT NULL,
      scans_used INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // compatibility columns
  if (!(await columnExists("alerts", "pinned"))) {
    await db.exec(`ALTER TABLE alerts ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;`);
  }
  if (!(await columnExists("alerts", "camera_id"))) {
    await db.exec(`ALTER TABLE alerts ADD COLUMN camera_id INTEGER;`);
  }
  if (!(await columnExists("alerts", "created_at"))) {
    await db.exec(`ALTER TABLE alerts ADD COLUMN created_at DATETIME DEFAULT CURRENT_TIMESTAMP;`);
  }
  if (!(await columnExists("cameras", "api_key"))) {
    await db.exec(`ALTER TABLE cameras ADD COLUMN api_key TEXT;`);
  }
  if (!(await columnExists("cameras", "location"))) {
    await db.exec(`ALTER TABLE cameras ADD COLUMN location TEXT;`);
  }
  if (!(await columnExists("cameras", "zone_id"))) {
    await db.exec(`ALTER TABLE cameras ADD COLUMN zone_id INTEGER;`);
  }
  if (!(await columnExists("known_face_images", "s3_key"))) {
    await db.exec(`ALTER TABLE known_face_images ADD COLUMN s3_key TEXT;`);
  }

  // seed plans if empty
  const row = await db.get("SELECT COUNT(*) as cnt FROM plans");
  if ((row?.cnt || 0) === 0) {
    await db.run(
      "INSERT INTO plans (name, price, cameras, scan_limit) VALUES (?,?,?,?)",
      "Free Trial",
      0,
      2,
      200
    );
    await db.run(
      "INSERT INTO plans (name, price, cameras, scan_limit) VALUES (?,?,?,?)",
      "Standard",
      19.99,
      4,
      3000
    );
    await db.run(
      "INSERT INTO plans (name, price, cameras, scan_limit) VALUES (?,?,?,?)",
      "Premium",
      49.99,
      10,
      10000
    );
    await db.run(
      "INSERT INTO plans (name, price, cameras, scan_limit) VALUES (?,?,?,?)",
      "Elite",
      99.99,
      999,
      30000
    );
  }
}

// -------------------------
// S3 helpers
// -------------------------
async function putImageToS3({ key, buffer, contentType = "image/jpeg" }) {
  const bucket = s3Bucket();
  if (!bucket) throw new Error("S3_BUCKET missing");
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      ACL: "private"
    })
  );
  return key;
}

async function getImageFromS3({ key }) {
  const bucket = s3Bucket();
  if (!bucket) throw new Error("S3_BUCKET missing");
  const out = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key
    })
  );
  return out; // { Body, ContentType, ... }
}

async function deleteImageFromS3({ key }) {
  const bucket = s3Bucket();
  if (!bucket) throw new Error("S3_BUCKET missing");
  await s3.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key
    })
  );
}

async function headImageInS3({ key }) {
  const bucket = s3Bucket();
  if (!bucket) throw new Error("S3_BUCKET missing");
  await s3.send(
    new HeadObjectCommand({
      Bucket: bucket,
      Key: key
    })
  );
  return true;
}

// -------------------------------------
// Alert retention: max 100 per user
// delete oldest UNPINNED only
// -------------------------------------
async function enforceAlertRetention(userEmail, max = 100) {
  const email = safeLower(userEmail);
  const countRow = await db.get(
    `SELECT COUNT(*) as cnt FROM alerts WHERE user_email=?`,
    email
  );
  const cnt = countRow?.cnt || 0;
  if (cnt <= max) return;

  const toDelete = cnt - max;

  const victims = await db.all(
    `
    SELECT id, image_key
    FROM alerts
    WHERE user_email=? AND pinned=0
    ORDER BY timestamp ASC
    LIMIT ?
    `,
    email,
    toDelete
  );

  for (const v of victims) {
    try {
      if (v.image_key) await deleteImageFromS3({ key: v.image_key });
    } catch (e) {
      // do not block deletion if S3 already missing
      console.warn("Retention S3 delete warn:", e?.message || e);
    }
    await db.run(`DELETE FROM alerts WHERE id=?`, v.id);
  }
}

// -------------------------------------
// Zone rules + cooldown (per zone, per person)
// NOTE: We only have "known/unknown" right now;
// If you later store person_id/face_id, we can make it "same person" properly.
// For now: cooldown applies per zone for unknown events.
// -------------------------------------
async function shouldCooldownUnknown(zoneId) {
  if (!zoneId) return false;

  const rule = await db.get(
    `SELECT rule_type, alert_interval FROM zone_rules WHERE zone_id=?`,
    zoneId
  );
  const minutes = Number(rule?.alert_interval || process.env.UNKNOWN_ALERT_COOLDOWN_MINUTES || 5);
  if (!minutes || minutes <= 0) return false;

  const sinceIso = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const recent = await db.get(
    `
    SELECT id FROM alerts
    WHERE zone_id=? AND type='unknown' AND timestamp >= ?
    ORDER BY timestamp DESC
    LIMIT 1
    `,
    zoneId,
    sinceIso
  );

  return !!recent;
}

async function ruleAllowsAlert(zoneId, isKnown) {
  if (!zoneId) return true; // no rule = allow
  const rule = await db.get(
    `SELECT rule_type FROM zone_rules WHERE zone_id=?`,
    zoneId
  );
  const rt = rule?.rule_type || "mixed";
  if (rt === "mixed") return true;
  if (rt === "known_only") return isKnown === true;
  if (rt === "unknown_only") return isKnown === false;
  return true;
}

// -------------------------------------
// Email helper (SES)
// -------------------------------------
async function sendAlertEmail({ toEmail, subject, bodyText }) {
  if (!process.env.SES_FROM_EMAIL) return false; // silent skip
  if (!toEmail) return false;

  try {
    await ses.send(
      new SendEmailCommand({
        Source: process.env.SES_FROM_EMAIL,
        Destination: { ToAddresses: [toEmail] },
        Message: {
          Subject: { Data: subject || "SpotAlert Alert" },
          Body: {
            Text: { Data: bodyText || "Alert" }
          }
        }
      })
    );
    return true;
  } catch (e) {
    console.error("SES send failed:", e?.message || e);
    return false;
  }
}

// -------------------------------------
// DB init
// -------------------------------------
async function initDb() {
  db = await open({
    filename: "./spotalert.db",
    driver: sqlite3.Database
  });

  await ensureSchema();

  // share handles
  app.set("db", db);
  app.set("rekognition", rekognition);
  app.set("ses", ses);
  app.set("s3", s3);

  console.log("✅ SQLite initialized");
}

// =======================================================
// HEALTH
// =======================================================
app.get("/", (req, res) => {
  res.json({ status: "SpotAlert backend running", time: nowIso() });
});

app.get("/api/status", (req, res) => {
  res.json({ ok: true, time: nowIso() });
});

// =======================================================
// AUTH (signup/login/reset + optional verify)
// =======================================================

// signup
app.post("/api/signup", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const email = safeLower(req.body.email);
    const password = String(req.body.password || "");

    if (!name || !email || !password) {
      return res.status(400).json({ error: "All fields are required." });
    }

    const existing = await db.get("SELECT id FROM users WHERE email=?", email);
    if (existing) return res.status(409).json({ error: "Email already registered." });

    const hash = await bcrypt.hash(password, 10);
    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + 14);

    // verification token (optional)
    const verifyToken = crypto.randomBytes(20).toString("hex");

    await db.run(
      `INSERT INTO users (name,email,password_hash,plan,trial_end,reset_token,email_verified,disabled)
       VALUES (?,?,?,?,?,?,?,?)`,
      name,
      email,
      hash,
      "Free Trial",
      trialEnd.toISOString(),
      verifyToken,
      1, // set 1 for now (you can switch to 0 if you want mandatory verify)
      0
    );

    // If you want verification emails ON, set email_verified=0 above, then send below:
    // await sendAlertEmail({ ...verify link... })

    const token = signToken({ email, plan: "Free Trial" });
    return res.json({ token, user: { name, email, plan: "Free Trial" } });
  } catch (e) {
    console.error("Signup error:", e);
    return res.status(500).json({ error: "Signup failed." });
  }
});

// compatibility route
app.post("/api/auth/signup", (req, res) => app._router.handle(req, res, () => {}));

// login
app.post("/api/login", async (req, res) => {
  try {
    const email = safeLower(req.body.email);
    const password = String(req.body.password || "");

    if (!email || !password) return res.status(400).json({ error: "Email and password required." });

    const user = await db.get("SELECT * FROM users WHERE email=?", email);
    if (!user) return res.status(401).json({ error: "Invalid credentials." });
    if (user.disabled) return res.status(403).json({ error: "Account disabled." });
    if (user.email_verified === 0) return res.status(403).json({ error: "Email not verified." });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials." });

    const token = signToken({ email: user.email, plan: user.plan });
    return res.json({
      token,
      user: { name: user.name, email: user.email, plan: user.plan }
    });
  } catch (e) {
    console.error("Login error:", e);
    return res.status(500).json({ error: "Login failed." });
  }
});

app.post("/api/auth/login", (req, res) => app._router.handle(req, res, () => {}));

// request reset (stores token; email can be sent via SES if you choose)
app.post("/api/auth/request-reset", async (req, res) => {
  try {
    const email = safeLower(req.body.email);
    if (!email) return res.json({ ok: true });

    const user = await db.get("SELECT id FROM users WHERE email=?", email);
    if (!user) return res.json({ ok: true });

    const token = crypto.randomBytes(12).toString("hex");
    const expires = new Date(Date.now() + 60 * 60 * 1000);

    await db.run(
      "UPDATE users SET reset_token=?, reset_expires=? WHERE email=?",
      token,
      expires.toISOString(),
      email
    );

    // optional: send reset link
    // await sendAlertEmail({ toEmail: email, subject: "Reset SpotAlert Password", bodyText: `Reset: ${process.env.FRONTEND_URL}/reset.html?token=${token}` });

    return res.json({ ok: true });
  } catch (e) {
    console.error("request-reset error:", e);
    return res.status(500).json({ error: "Could not create reset token." });
  }
});

// reset password
app.post("/api/auth/reset", async (req, res) => {
  try {
    const token = String(req.body.token || "").trim();
    const password = String(req.body.password || "");
    if (!token || !password) return res.status(400).json({ error: "Missing token or password" });

    const user = await db.get(
      "SELECT id, reset_expires FROM users WHERE reset_token=?",
      token
    );
    if (!user) return res.status(400).json({ error: "Invalid token" });

    const exp = user.reset_expires ? new Date(user.reset_expires).getTime() : 0;
    if (exp && Date.now() > exp) return res.status(400).json({ error: "Token expired" });

    const hash = await bcrypt.hash(password, 10);
    await db.run(
      "UPDATE users SET password_hash=?, reset_token=NULL, reset_expires=NULL WHERE id=?",
      hash,
      user.id
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error("reset error:", e);
    return res.status(500).json({ error: "Reset failed" });
  }
});

// verify email (optional flow)
app.post("/api/verify", async (req, res) => {
  try {
    const token = String(req.body.token || "").trim();
    if (!token) return res.status(400).json({ error: "Missing token" });

    const user = await db.get("SELECT id FROM users WHERE reset_token=?", token);
    if (!user) return res.status(400).json({ error: "Invalid token" });

    await db.run("UPDATE users SET email_verified=1, reset_token=NULL WHERE id=?", user.id);
    return res.json({ ok: true });
  } catch (e) {
    console.error("verify error:", e);
    return res.status(500).json({ error: "Verification failed" });
  }
});

// =======================================================
// ADMIN (activated with real DB)
// =======================================================
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    const token = jwt.sign({ role: "admin" }, process.env.JWT_SECRET, { expiresIn: "12h" });
    return res.json({ ok: true, token });
  }
  return res.status(401).json({ error: "Invalid admin credentials" });
});

app.get("/api/admin/users", adminAuth, async (req, res) => {
  try {
    const users = await db.all(
      `SELECT id,name,email,plan,trial_end,created_at,email_verified,disabled
       FROM users
       ORDER BY created_at DESC
       LIMIT 500`
    );
    return res.json({ ok: true, users });
  } catch (e) {
    console.error("admin users error:", e);
    return res.status(500).json({ error: "Failed to load users" });
  }
});

app.get("/api/admin/analytics", adminAuth, async (req, res) => {
  try {
    const total_users = await db.get("SELECT COUNT(*) as c FROM users");
    const total_alerts = await db.get("SELECT COUNT(*) as c FROM alerts");
    const revenue = await db.get("SELECT SUM(cost) as s FROM alerts");
    return res.json({
      total_users: total_users?.c || 0,
      total_alerts: total_alerts?.c || 0,
      revenue: Number(revenue?.s || 0)
    });
  } catch (e) {
    console.error("admin analytics error:", e);
    return res.status(500).json({ error: "Failed to load analytics" });
  }
});

app.post("/api/admin/user/disable", adminAuth, async (req, res) => {
  try {
    const email = safeLower(req.body.email);
    if (!email) return res.status(400).json({ error: "Missing email" });
    await db.run("UPDATE users SET disabled=1 WHERE email=?", email);
    return res.json({ ok: true });
  } catch (e) {
    console.error("disable user error:", e);
    return res.status(500).json({ error: "Failed" });
  }
});

app.post("/api/admin/user/enable", adminAuth, async (req, res) => {
  try {
    const email = safeLower(req.body.email);
    if (!email) return res.status(400).json({ error: "Missing email" });
    await db.run("UPDATE users SET disabled=0 WHERE email=?", email);
    return res.json({ ok: true });
  } catch (e) {
    console.error("enable user error:", e);
    return res.status(500).json({ error: "Failed" });
  }
});

// =======================================================
// TIMEZONE + EVENT LOGGING (persisted)
// POST /api/timezone
// POST /api/log-event
// =======================================================
app.post("/api/timezone", async (req, res) => {
  try {
    const email = safeLower(req.body.email);
    const timezone = String(req.body.timezone || "").trim();
    await db.run(
      "INSERT INTO event_logs (user_email,type,payload) VALUES (?,?,?)",
      email || null,
      "timezone",
      JSON.stringify({ timezone, email, at: nowIso() })
    );
    return res.json({ ok: true });
  } catch (e) {
    console.error("timezone error:", e);
    return res.status(500).json({ error: "Failed to save timezone" });
  }
});

app.post("/api/log-event", async (req, res) => {
  try {
    const email = safeLower(req.body.email);
    const event = req.body.event;
    await db.run(
      "INSERT INTO event_logs (user_email,type,payload) VALUES (?,?,?)",
      email || null,
      "event",
      JSON.stringify({ event, email, at: nowIso() })
    );
    return res.json({ ok: true });
  } catch (e) {
    console.error("log-event error:", e);
    return res.status(500).json({ error: "Failed to log event" });
  }
});

// =======================================================
// LOCATIONS
// =======================================================
app.post("/api/locations", auth, async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const address = String(req.body.address || "").trim();
    if (!name) return res.status(400).json({ error: "Name required" });

    const email = safeLower(req.user.email);
    const r = await db.run(
      "INSERT INTO locations (user_email,name,address) VALUES (?,?,?)",
      email,
      name,
      address
    );
    return res.json({ ok: true, id: r.lastID });
  } catch (e) {
    console.error("create location error:", e);
    return res.status(500).json({ error: "Failed" });
  }
});

app.get("/api/locations", auth, async (req, res) => {
  try {
    const email = safeLower(req.user.email);
    const rows = await db.all(
      "SELECT id,name,address,created_at FROM locations WHERE user_email=? ORDER BY created_at DESC",
      email
    );
    return res.json(rows);
  } catch (e) {
    console.error("list locations error:", e);
    return res.status(500).json({ error: "Failed" });
  }
});

app.delete("/api/locations/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const email = safeLower(req.user.email);
    const loc = await db.get("SELECT id FROM locations WHERE id=? AND user_email=?", id, email);
    if (!loc) return res.status(404).json({ error: "Not found" });

    await db.run("DELETE FROM zones WHERE location_id=?", id);
    await db.run("DELETE FROM locations WHERE id=?", id);

    return res.json({ ok: true });
  } catch (e) {
    console.error("delete location error:", e);
    return res.status(500).json({ error: "Failed" });
  }
});

// =======================================================
// ZONES
// =======================================================
app.post("/api/zones", auth, async (req, res) => {
  try {
    const location_id = Number(req.body.location_id);
    const name = String(req.body.name || "").trim();
    const cost_per_scan = Number(req.body.cost_per_scan || 0.001);
    const active_hours = req.body.active_hours ? JSON.stringify(req.body.active_hours) : null;

    if (!location_id || !name) return res.status(400).json({ error: "Missing fields" });

    // ownership check
    const email = safeLower(req.user.email);
    const loc = await db.get("SELECT id FROM locations WHERE id=? AND user_email=?", location_id, email);
    if (!loc) return res.status(403).json({ error: "Forbidden" });

    const r = await db.run(
      "INSERT INTO zones (location_id,name,cost_per_scan,active_hours) VALUES (?,?,?,?)",
      location_id,
      name,
      cost_per_scan,
      active_hours
    );

    // ensure a default rule exists
    await db.run(
      "INSERT OR IGNORE INTO zone_rules (zone_id, rule_type, alert_interval) VALUES (?,?,?)",
      r.lastID,
      "unknown_only",
      Number(process.env.UNKNOWN_ALERT_COOLDOWN_MINUTES || 5)
    );

    return res.json({ ok: true, id: r.lastID });
  } catch (e) {
    console.error("create zone error:", e);
    return res.status(500).json({ error: "Failed" });
  }
});

app.get("/api/zones", auth, async (req, res) => {
  try {
    const email = safeLower(req.user.email);
    const rows = await db.all(
      `
      SELECT z.id, z.location_id, z.name, z.cost_per_scan, z.active_hours, z.created_at,
             l.name as location_name
      FROM zones z
      JOIN locations l ON l.id = z.location_id
      WHERE l.user_email=?
      ORDER BY z.created_at DESC
      `,
      email
    );
    return res.json(rows);
  } catch (e) {
    console.error("list zones error:", e);
    return res.status(500).json({ error: "Failed" });
  }
});

app.delete("/api/zones/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const email = safeLower(req.user.email);

    const row = await db.get(
      `
      SELECT z.id
      FROM zones z
      JOIN locations l ON l.id = z.location_id
      WHERE z.id=? AND l.user_email=?
      `,
      id,
      email
    );
    if (!row) return res.status(404).json({ error: "Not found" });

    await db.run("DELETE FROM zone_rules WHERE zone_id=?", id);
    await db.run("UPDATE cameras SET zone_id=NULL WHERE zone_id=?", id);
    await db.run("UPDATE alerts SET zone_id=NULL WHERE zone_id=?", id);
    await db.run("DELETE FROM zones WHERE id=?", id);

    return res.json({ ok: true });
  } catch (e) {
    console.error("delete zone error:", e);
    return res.status(500).json({ error: "Failed" });
  }
});

// =======================================================
// ZONE RULES
// =======================================================
app.post("/api/zone-rules", auth, async (req, res) => {
  try {
    const zone_id = Number(req.body.zone_id);
    const rule_type = String(req.body.rule_type || "").trim();
    const alert_interval = Number(req.body.alert_interval || 10);

    if (!zone_id || !rule_type) return res.status(400).json({ error: "Missing rule data" });

    const allowed = ["known_only", "unknown_only", "mixed"];
    if (!allowed.includes(rule_type)) return res.status(400).json({ error: "Invalid rule type" });

    // ownership check
    const email = safeLower(req.user.email);
    const z = await db.get(
      `
      SELECT z.id
      FROM zones z
      JOIN locations l ON l.id=z.location_id
      WHERE z.id=? AND l.user_email=?
      `,
      zone_id,
      email
    );
    if (!z) return res.status(403).json({ error: "Forbidden" });

    await db.run(
      `
      INSERT INTO zone_rules (zone_id, rule_type, alert_interval)
      VALUES (?,?,?)
      ON CONFLICT(zone_id) DO UPDATE SET rule_type=excluded.rule_type, alert_interval=excluded.alert_interval
      `,
      zone_id,
      rule_type,
      alert_interval
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error("zone rule save error:", e);
    return res.status(500).json({ error: "Failed to save zone rule" });
  }
});

app.get("/api/zone-rules/:zoneId", auth, async (req, res) => {
  try {
    const zoneId = Number(req.params.zoneId);
    if (!zoneId) return res.status(400).json({ error: "Invalid zone id" });

    // ownership check
    const email = safeLower(req.user.email);
    const z = await db.get(
      `
      SELECT z.id
      FROM zones z
      JOIN locations l ON l.id=z.location_id
      WHERE z.id=? AND l.user_email=?
      `,
      zoneId,
      email
    );
    if (!z) return res.status(403).json({ error: "Forbidden" });

    const rule = await db.get(
      "SELECT zone_id, rule_type, alert_interval FROM zone_rules WHERE zone_id=?",
      zoneId
    );
    return res.json(rule || {});
  } catch (e) {
    console.error("zone rule load error:", e);
    return res.status(500).json({ error: "Failed to load rule" });
  }
});

app.delete("/api/zone-rules/:zoneId", auth, async (req, res) => {
  try {
    const zoneId = Number(req.params.zoneId);
    if (!zoneId) return res.status(400).json({ error: "Invalid zone id" });

    // ownership check
    const email = safeLower(req.user.email);
    const z = await db.get(
      `
      SELECT z.id
      FROM zones z
      JOIN locations l ON l.id=z.location_id
      WHERE z.id=? AND l.user_email=?
      `,
      zoneId,
      email
    );
    if (!z) return res.status(403).json({ error: "Forbidden" });

    await db.run("DELETE FROM zone_rules WHERE zone_id=?", zoneId);
    return res.json({ ok: true });
  } catch (e) {
    console.error("zone rule delete error:", e);
    return res.status(500).json({ error: "Failed to delete rule" });
  }
});

// =======================================================
// CAMERAS (JWT) + CCTV SNAPSHOT INGEST (X-Camera-Key)
// =======================================================

// register camera (JWT)
app.post("/api/camera/register", auth, async (req, res) => {
  try {
    const email = safeLower(req.user.email);
    const name = String(req.body.name || "").trim();
    const location = String(req.body.location || "").trim();
    const ip = String(req.body.ip || "").trim();
    const zone_id = req.body.zone_id ? Number(req.body.zone_id) : null;

    if (!name) return res.status(400).json({ error: "Camera name required" });

    // If zone provided, confirm ownership
    if (zone_id) {
      const z = await db.get(
        `
        SELECT z.id
        FROM zones z
        JOIN locations l ON l.id=z.location_id
        WHERE z.id=? AND l.user_email=?
        `,
        zone_id,
        email
      );
      if (!z) return res.status(403).json({ error: "Invalid zone" });
    }

    const api_key = crypto.randomBytes(18).toString("hex");

    const r = await db.run(
      `INSERT INTO cameras (user_email,name,location,ip,zone_id,api_key)
       VALUES (?,?,?,?,?,?)`,
      email,
      name,
      location,
      ip,
      zone_id,
      api_key
    );

    return res.json({ ok: true, cameraId: r.lastID, api_key });
  } catch (e) {
    console.error("camera register error:", e);
    return res.status(500).json({ error: "Failed to register camera" });
  }
});

// list cameras (JWT)
app.get("/api/camera/list", auth, async (req, res) => {
  try {
    const email = safeLower(req.user.email);
    const rows = await db.all(
      `SELECT id,name,location,ip,zone_id,created_at
       FROM cameras
       WHERE user_email=?
       ORDER BY created_at DESC`,
      email
    );
    return res.json(rows);
  } catch (e) {
    console.error("camera list error:", e);
    return res.status(500).json({ error: "Failed to list cameras" });
  }
});

// delete camera (JWT)
app.delete("/api/camera/:id", auth, async (req, res) => {
  try {
    const email = safeLower(req.user.email);
    const id = Number(req.params.id);
    await db.run("DELETE FROM cameras WHERE id=? AND user_email=?", id, email);
    return res.json({ ok: true });
  } catch (e) {
    console.error("camera delete error:", e);
    return res.status(500).json({ error: "Failed to delete camera" });
  }
});

// CCTV ingest (NO JWT) — uses X-Camera-Key
// POST /api/cctv/:id/snapshot
// FormData: image=<file>
app.post("/api/cctv/:id/snapshot", upload.single("image"), async (req, res) => {
  try {
    const cameraKey = String(req.headers["x-camera-key"] || "");
    if (!cameraKey) return res.status(401).json({ error: "Missing X-Camera-Key" });
    if (!req.file?.buffer) return res.status(400).json({ error: "Missing image file" });

    const cameraId = Number(req.params.id);
    const cam = await db.get(
      "SELECT id,user_email,api_key,zone_id FROM cameras WHERE id=?",
      cameraId
    );
    if (!cam) return res.status(404).json({ error: "Camera not found" });
    if (String(cam.api_key) !== String(cameraKey)) return res.status(403).json({ error: "Invalid camera key" });

    // pipe into unified alert pipeline
    const result = await processAlertPipeline({
      userEmail: cam.user_email,
      zoneId: cam.zone_id || null,
      cameraId: cam.id,
      imageBuffer: req.file.buffer,
      channel: "cctv",
      meta: { ip: req.ip }
    });

    return res.json(result);
  } catch (e) {
    console.error("snapshot ingest error:", e);
    return res.status(500).json({ error: "Snapshot ingest failed" });
  }
});

// =======================================================
// KNOWN FACES (S3 + Rekognition IndexFaces)
// =======================================================

// create known person
app.post("/api/known_faces", auth, async (req, res) => {
  try {
    const email = safeLower(req.user.email);
    const first_name = String(req.body.first_name || "").trim();
    const last_name = String(req.body.last_name || "").trim();
    if (!first_name || !last_name) return res.status(400).json({ error: "Missing name" });

    const r = await db.run(
      "INSERT INTO known_faces (user_email,first_name,last_name) VALUES (?,?,?)",
      email,
      first_name,
      last_name
    );

    return res.json({ ok: true, id: r.lastID });
  } catch (e) {
    console.error("create known face error:", e);
    return res.status(500).json({ error: "Failed" });
  }
});

// list known persons
app.get("/api/known_faces", auth, async (req, res) => {
  try {
    const email = safeLower(req.user.email);
    const rows = await db.all(
      "SELECT id,first_name,last_name,created_at FROM known_faces WHERE user_email=? ORDER BY created_at DESC",
      email
    );
    return res.json(rows);
  } catch (e) {
    console.error("list known faces error:", e);
    return res.status(500).json({ error: "Failed" });
  }
});

// upload known face image -> store S3 + IndexFaces -> save face_id
app.post("/api/known_faces/:id/image", auth, upload.single("image"), async (req, res) => {
  try {
    const email = safeLower(req.user.email);
    const knownId = Number(req.params.id);
    if (!knownId) return res.status(400).json({ error: "Invalid id" });
    if (!req.file?.buffer) return res.status(400).json({ error: "Missing image file" });

    const bucket = s3Bucket();
    const collection = rekogCollection();
    if (!bucket) return res.status(500).json({ error: "S3_BUCKET missing" });
    if (!collection) return res.status(500).json({ error: "REKOG_COLLECTION_ID missing" });

    // ownership check
    const person = await db.get(
      "SELECT id,first_name,last_name FROM known_faces WHERE id=? AND user_email=?",
      knownId,
      email
    );
    if (!person) return res.status(404).json({ error: "Not found" });

    // S3 key
    const key = `known_faces/${email}/${knownId}/${Date.now()}_${crypto.randomBytes(6).toString("hex")}.jpg`;

    await putImageToS3({ key, buffer: req.file.buffer, contentType: req.file.mimetype || "image/jpeg" });

    // Index to Rekognition
    let faceId = null;
    try {
      const idx = await rekognition.send(
        new IndexFacesCommand({
          CollectionId: collection,
          Image: {
            S3Object: { Bucket: bucket, Name: key }
          },
          ExternalImageId: `${email}:${knownId}`,
          DetectionAttributes: []
        })
      );
      const records = idx?.FaceRecords || [];
      if (records.length > 0 && records[0]?.Face?.FaceId) {
        faceId = records[0].Face.FaceId;
      }
    } catch (e) {
      console.error("IndexFaces failed:", e?.message || e);
    }

    await db.run(
      "INSERT INTO known_face_images (known_face_id, face_id, s3_key) VALUES (?,?,?)",
      knownId,
      faceId,
      key
    );

    return res.json({ ok: true, s3_key: key, face_id: faceId });
  } catch (e) {
    console.error("known face image upload error:", e);
    return res.status(500).json({ error: "Failed" });
  }
});

// delete known person (and optionally delete faces + S3 images)
app.delete("/api/known_faces/:id", auth, async (req, res) => {
  try {
    const email = safeLower(req.user.email);
    const knownId = Number(req.params.id);

    const person = await db.get(
      "SELECT id FROM known_faces WHERE id=? AND user_email=?",
      knownId,
      email
    );
    if (!person) return res.status(404).json({ error: "Not found" });

    const imgs = await db.all(
      "SELECT id, face_id, s3_key FROM known_face_images WHERE known_face_id=?",
      knownId
    );

    // delete from rekognition collection if face_id exists
    const collection = rekogCollection();
    if (collection) {
      const faceIds = imgs.map((i) => i.face_id).filter(Boolean);
      if (faceIds.length) {
        try {
          await rekognition.send(
            new DeleteFacesCommand({
              CollectionId: collection,
              FaceIds: faceIds
            })
          );
        } catch (e) {
          console.warn("DeleteFaces warn:", e?.message || e);
        }
      }
    }

    // delete S3 images
    for (const i of imgs) {
      if (i.s3_key) {
        try {
          await deleteImageFromS3({ key: i.s3_key });
        } catch (e) {
          console.warn("S3 delete known face warn:", e?.message || e);
        }
      }
    }

    await db.run("DELETE FROM known_face_images WHERE known_face_id=?", knownId);
    await db.run("DELETE FROM known_faces WHERE id=?", knownId);

    return res.json({ ok: true });
  } catch (e) {
    console.error("delete known face error:", e);
    return res.status(500).json({ error: "Failed" });
  }
});

// =======================================================
// PLANS + USAGE
// =======================================================
app.get("/api/plans", async (req, res) => {
  try {
    const plans = await db.all("SELECT id,name,price,cameras,scan_limit FROM plans ORDER BY price ASC");
    return res.json(plans);
  } catch (e) {
    console.error("plans error:", e);
    return res.status(500).json({ error: "Could not load plans." });
  }
});

// JWT usage summary
app.get("/api/usage-summary", auth, async (req, res) => {
  try {
    const email = safeLower(req.user.email);
    const month = monthKey();

    const rows = await db.all(
      `
      SELECT channel, COUNT(*) as count, SUM(cost) as total
      FROM alerts
      WHERE user_email=? AND strftime('%Y-%m', timestamp)=?
      GROUP BY channel
      `,
      email,
      month
    );

    const total = rows.reduce((s, r) => s + Number(r.total || 0), 0);

    return res.json({
      month,
      total_cost_usd: Number(total.toFixed(3)),
      details: rows.map((r) => ({
        channel: r.channel,
        count: r.count,
        total: Number((r.total || 0).toFixed(3))
      }))
    });
  } catch (e) {
    console.error("usage-summary error:", e);
    return res.status(500).json({ error: "Usage calculation failed" });
  }
});

// =======================================================
// STRIPE BILLING (JWT) — create checkout session
// expects env: STRIPE_PRICE_STANDARD, STRIPE_PRICE_PREMIUM (price IDs), etc.
// =======================================================
app.post("/api/billing/create-checkout-session", auth, async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: "Stripe not configured" });

    const email = safeLower(req.user.email);
    const plan = String(req.body.plan || "").trim();
    if (!plan) return res.status(400).json({ error: "Missing plan" });

    const PRICE_MAP = {
      Standard: process.env.STRIPE_PRICE_STANDARD,
      Premium: process.env.STRIPE_PRICE_PREMIUM,
      Elite: process.env.STRIPE_PRICE_ELITE
    };

    if (!PRICE_MAP[plan]) return res.status(400).json({ error: "Invalid plan" });

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      customer_email: email,
      line_items: [{ price: PRICE_MAP[plan], quantity: 1 }],
      metadata: { plan, email },
      success_url: `${process.env.FRONTEND_URL || "https://spotalert.live"}/dashboard.html?payment=success`,
      cancel_url: `${process.env.FRONTEND_URL || "https://spotalert.live"}/plans.html?payment=cancel`
    });

    return res.json({ url: session.url });
  } catch (e) {
    console.error("Stripe checkout error:", e);
    return res.status(500).json({ error: "Checkout failed" });
  }
});

// =======================================================
// ALERTS DASHBOARD API (JWT) — list / image / delete / pin
// =======================================================

// list alerts for logged user
// GET /api/alerts/list?type=unknown|known|all
app.get("/api/alerts/list", auth, async (req, res) => {
  try {
    const email = safeLower(req.user.email);
    const type = safeLower(req.query.type || "unknown"); // default unknown

    let rows = [];
    if (type === "all") {
      rows = await db.all(
        `SELECT id,user_email,type,image_key,channel,cost,zone_id,camera_id,pinned,timestamp
         FROM alerts
         WHERE user_email=?
         ORDER BY timestamp DESC
         LIMIT 200`,
        email
      );
    } else {
      rows = await db.all(
        `SELECT id,user_email,type,image_key,channel,cost,zone_id,camera_id,pinned,timestamp
         FROM alerts
         WHERE user_email=? AND type=?
         ORDER BY timestamp DESC
         LIMIT 200`,
        email,
        type
      );
    }

    const base = apiBase();
    const mapped = rows.map((r) => ({
      ...r,
      image_url: r.image_key ? `${base}/api/alerts/${r.id}/image` : null
    }));

    return res.json(mapped);
  } catch (e) {
    console.error("alerts list error:", e);
    return res.status(500).json({ error: "Failed to load alerts" });
  }
});

// stream alert image from S3 (owner only)
app.get("/api/alerts/:id/image", auth, async (req, res) => {
  try {
    const email = safeLower(req.user.email);
    const id = Number(req.params.id);

    const row = await db.get(
      "SELECT id,user_email,image_key FROM alerts WHERE id=?",
      id
    );
    if (!row) return res.status(404).json({ error: "Not found" });
    if (safeLower(row.user_email) !== email) return res.status(403).json({ error: "Forbidden" });
    if (!row.image_key) return res.status(404).json({ error: "No image" });

    // fetch from S3
    const out = await getImageFromS3({ key: row.image_key });

    // content type
    res.setHeader("Content-Type", out.ContentType || "image/jpeg");
    res.setHeader("Cache-Control", "no-store");

    return streamToRes(out.Body, res);
  } catch (e) {
    console.error("alert image error:", e);
    return res.status(500).json({ error: "Failed to load image" });
  }
});

// pin/unpin alert (protect from retention delete)
app.post("/api/alerts/:id/pin", auth, async (req, res) => {
  try {
    const email = safeLower(req.user.email);
    const id = Number(req.params.id);
    const pinned = req.body.pinned ? 1 : 0;

    const row = await db.get("SELECT id,user_email FROM alerts WHERE id=?", id);
    if (!row) return res.status(404).json({ error: "Not found" });
    if (safeLower(row.user_email) !== email) return res.status(403).json({ error: "Forbidden" });

    await db.run("UPDATE alerts SET pinned=? WHERE id=?", pinned, id);
    return res.json({ ok: true, pinned });
  } catch (e) {
    console.error("pin alert error:", e);
    return res.status(500).json({ error: "Failed" });
  }
});

// delete alert (owner only) + delete S3 image
app.delete("/api/alerts/:id", auth, async (req, res) => {
  try {
    const email = safeLower(req.user.email);
    const id = Number(req.params.id);

    const row = await db.get(
      "SELECT id,user_email,image_key,pinned FROM alerts WHERE id=?",
      id
    );
    if (!row) return res.status(404).json({ error: "Not found" });
    if (safeLower(row.user_email) !== email) return res.status(403).json({ error: "Forbidden" });

    // allow delete pinned too (customer choice) — you requested “not deleted at all if possible”
    // Here: pinned prevents auto-delete, but user can still delete manually.
    if (row.image_key) {
      try {
        await deleteImageFromS3({ key: row.image_key });
      } catch (e) {
        console.warn("Could not delete S3 image:", e?.message || e);
      }
    }

    await db.run("DELETE FROM alerts WHERE id=?", id);

    return res.json({ ok: true });
  } catch (e) {
    console.error("delete alert error:", e);
    return res.status(500).json({ error: "Delete failed" });
  }
});

// =======================================================
// ELITE REPLAY (kept compatible)
// =======================================================
app.get("/api/elite/replay", auth, async (req, res) => {
  try {
    const email = safeLower(req.user.email);
    const minutes = Number(req.query.minutes || 10);
    const since = new Date(Date.now() - minutes * 60000).toISOString();

    const rows = await db.all(
      `SELECT id,type,image_key as image_key,pinned,timestamp
       FROM alerts
       WHERE user_email=? AND timestamp>=?
       ORDER BY timestamp DESC
       LIMIT 20`,
      email,
      since
    );

    const base = apiBase();
    const mapped = rows.map((r) => ({
      ...r,
      image_url: r.image_key ? `${base}/api/alerts/${r.id}/image` : null
    }));

    return res.json(mapped);
  } catch (e) {
    console.error("elite replay error:", e);
    return res.status(500).json({ error: "Replay load failed" });
  }
});

app.get("/api/elite/frame-url", auth, (req, res) => {
  return res.json({
    url: "cctv_background.png",
    key: req.query.key || ""
  });
});

app.get("/api/elite/incident-pdf", auth, (req, res) => {
  res.setHeader("Content-Type", "application/pdf");
  return res.send(
    Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF", "utf8")
  );
});

// =======================================================
// AUTHORITIES (kept minimal but ACTIVE)
// =======================================================
app.post("/api/authorities/report", auth, async (req, res) => {
  try {
    // you can extend this to email police/security
    const email = safeLower(req.user.email);
    const payload = req.body || {};
    await db.run(
      "INSERT INTO event_logs (user_email,type,payload) VALUES (?,?,?)",
      email,
      "authorities_report",
      JSON.stringify({ payload, at: nowIso() })
    );
    return res.json({ ok: true });
  } catch (e) {
    console.error("authorities report error:", e);
    return res.status(500).json({ error: "Failed" });
  }
});

// =======================================================
// CORE ALERT PIPELINE (S3 + Rekognition + rules + retention)
// used by /api/trigger-alert and CCTV ingest
// =======================================================
async function processAlertPipeline({ userEmail, zoneId, cameraId, imageBuffer, channel = "email", meta = {} }) {
  const email = safeLower(userEmail);
  if (!email) return { ok: false, error: "Missing user email" };

  const bucket = s3Bucket();
  const collection = rekogCollection();
  if (!bucket) return { ok: false, error: "S3_BUCKET missing" };
  if (!collection) return { ok: false, error: "REKOG_COLLECTION_ID missing" };

  // cooldown (unknown)
  const inCooldown = await shouldCooldownUnknown(zoneId);
  if (inCooldown) {
    return { ok: true, skipped: true, reason: "cooldown", zone_id: zoneId || null };
  }

  // rekognition search
  let matches = [];
  try {
    const rekogRes = await rekognition.send(
      new SearchFacesByImageCommand({
        CollectionId: collection,
        Image: { Bytes: imageBuffer }
      })
    );
    matches = rekogRes.FaceMatches || [];
  } catch (e) {
    console.error("Rekognition search failed:", e?.message || e);
    matches = [];
  }

  const isKnown = matches.length > 0;

  // rule filter
  const allowed = await ruleAllowsAlert(zoneId, isKnown);
  if (!allowed) {
    return { ok: true, skipped: true, reason: "zone_rule_block", zone_id: zoneId || null, type: isKnown ? "known" : "unknown" };
  }

  // cost (zone aware)
  let cost = 0.001;
  if (zoneId) {
    const z = await db.get("SELECT cost_per_scan FROM zones WHERE id=?", zoneId);
    if (z?.cost_per_scan != null) cost = Number(z.cost_per_scan);
  }

  // store image in S3 (ALWAYS)
  const key = `alerts/${email}/${Date.now()}_${crypto.randomBytes(6).toString("hex")}.jpg`;

  try {
    await putImageToS3({ key, buffer: imageBuffer, contentType: "image/jpeg" });
  } catch (e) {
    console.error("S3 put failed:", e?.message || e);
    return { ok: false, error: "S3 upload failed" };
  }

  // insert alert
  const insert = await db.run(
    `INSERT INTO alerts (user_email,type,image_key,channel,cost,zone_id,camera_id,pinned,timestamp)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    email,
    isKnown ? "known" : "unknown",
    key,
    channel || "email",
    cost,
    zoneId || null,
    cameraId || null,
    0,
    nowIso()
  );

  const alertId = insert?.lastID;

  // retention enforcement (100 max, deletes oldest unpinned only)
  const maxAlerts = Number(process.env.MAX_ALERTS_PER_USER || 100);
  await enforceAlertRetention(email, maxAlerts);

  // email for unknown
  if (!isKnown) {
    const subject = process.env.ALERT_SUBJECT || "[SpotAlert] Unknown Face Detected";
    const dash = `${process.env.FRONTEND_URL || "https://spotalert.live"}/dashboard.html`;
    const bodyText =
`Unknown person detected.

Login to view snapshot:
${dash}

Alert ID: ${alertId}
Zone: ${zoneId || "N/A"}
Time: ${nowIso()}

(Your snapshot is stored securely in SpotAlert)`;

    await sendAlertEmail({ toEmail: email, subject, bodyText });
  }

  return {
    ok: true,
    alert_id: alertId,
    type: isKnown ? "known" : "unknown",
    faces: matches,
    cost,
    zone_id: zoneId || null,
    camera_id: cameraId || null,
    image_key: key
  };
}

// Manual trigger alert endpoint (for testing / connectors)
app.post("/api/trigger-alert", upload.single("image"), async (req, res) => {
  try {
    if (!req.file?.buffer) return res.status(400).json({ error: "Missing image file." });

    const email = safeLower(req.body.email);
    const zoneId = req.body.zone_id ? Number(req.body.zone_id) : null;
    const cameraId = req.body.camera_id ? Number(req.body.camera_id) : null;

    if (!email) return res.status(400).json({ error: "Missing email" });

    const result = await processAlertPipeline({
      userEmail: email,
      zoneId,
      cameraId,
      imageBuffer: req.file.buffer,
      channel: "email",
      meta: { ip: req.ip }
    });

    if (!result.ok) return res.status(500).json(result);
    return res.json(result);
  } catch (e) {
    console.error("trigger-alert error:", e);
    return res.status(500).json({ error: "Alert processing failed." });
  }
});

// =======================================================
// START SERVER
// =======================================================
const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 SpotAlert backend running on port ${PORT}`);
      console.log(`✅ API_BASE_URL: ${apiBase() || "(not set)"}`);
      console.log(`✅ FRONTEND_URL: ${process.env.FRONTEND_URL || "(not set)"}`);
      console.log(`✅ S3_BUCKET: ${s3Bucket() || "(missing)"}`);
      console.log(`✅ REKOG_COLLECTION_ID: ${rekogCollection() || "(missing)"}`);
    });
  })
  .catch((err) => {
    console.error("Failed to init DB:", err);
    process.exit(1);
  });

export default app;
