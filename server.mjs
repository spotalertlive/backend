cd /home/ubuntu/spotalert-backend && \
ts="$(date +%F_%H%M%S)" && \
mkdir -p /home/ubuntu/_backup_spotalert && \
tar -czf "/home/ubuntu/_backup_spotalert/spotalert-backend_${ts}.tgz" . && \
cat > package.json <<'JSON'
{
  "name": "spotalert-backend",
  "version": "1.0.0",
  "description": "SpotAlert FULL Backend (ESM) — Auth + Email Verify + Alerts + S3 + Rekognition + Zones + Cameras + Stripe",
  "type": "module",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "engines": { "node": ">=18.0.0" },
  "dependencies": {
    "@aws-sdk/client-rekognition": "^3.657.0",
    "@aws-sdk/client-s3": "^3.657.0",
    "@aws-sdk/client-ses": "^3.657.0",
    "bcryptjs": "^2.4.3",
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "jsonwebtoken": "^9.0.2",
    "multer": "^1.4.5-lts.2",
    "sqlite": "^5.1.1",
    "sqlite3": "^5.1.7",
    "stripe": "^16.3.0"
  }
}
JSON
cat > server.js <<'EOF'
import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";

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
  DeleteObjectCommand
} from "@aws-sdk/client-s3";

import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

// Stripe (optional but supported)
import Stripe from "stripe";

dotenv.config();

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true }));

const upload = multer({ storage: multer.memoryStorage() });

/* =========================
   CORS
========================= */
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

/* =========================
   HELPERS
========================= */
function safeLower(s) {
  return String(s || "").toLowerCase().trim();
}
function nowIso() {
  return new Date().toISOString();
}
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} missing`);
  return v;
}
function apiBase() {
  return process.env.API_BASE_URL || "";
}
function frontendBase() {
  return process.env.FRONTEND_URL || "https://spotalert.live";
}
function s3Bucket() {
  return process.env.S3_BUCKET || process.env.S3_BUCKET_NAME || "";
}
function collectionId() {
  return process.env.REKOG_COLLECTION_ID || "";
}
function signToken(payload) {
  requireEnv("JWT_SECRET");
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "30d" });
}
function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
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
  readable.on("error", () => {
    try { res.status(500).end(); } catch {}
  });
  readable.pipe(res);
}

/* =========================
   AWS CLIENTS (ESM)
========================= */
const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const rekognition = new RekognitionClient({ region: AWS_REGION });
const s3 = new S3Client({ region: AWS_REGION });
const ses = new SESClient({ region: AWS_REGION });

/* =========================
   STRIPE (optional)
========================= */
const stripe =
  process.env.STRIPE_SECRET_KEY && !String(process.env.STRIPE_SECRET_KEY).includes("REPLACE_ME")
    ? new Stripe(process.env.STRIPE_SECRET_KEY)
    : null;

/* =========================
   DB INIT + MIGRATIONS
========================= */
let db;

async function ensureSchema() {
  await db.exec(`
    PRAGMA journal_mode=WAL;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'Free Trial',
      trial_end DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      verify_token TEXT,
      email_verified INTEGER DEFAULT 0,
      reset_token TEXT,
      reset_expires DATETIME,
      disabled INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      price REAL,
      cameras INTEGER,
      scan_limit INTEGER
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
      rule_type TEXT NOT NULL DEFAULT 'unknown_only',
      alert_interval INTEGER NOT NULL DEFAULT 10,
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

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_email TEXT NOT NULL,
      type TEXT NOT NULL,
      image_key TEXT,
      channel TEXT NOT NULL DEFAULT 'email',
      cost REAL NOT NULL DEFAULT 0,
      zone_id INTEGER,
      camera_id INTEGER,
      pinned INTEGER NOT NULL DEFAULT 0,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
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
      face_id TEXT,
      s3_key TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const cnt = await db.get("SELECT COUNT(*) AS c FROM plans");
  if ((cnt?.c || 0) === 0) {
    await db.run("INSERT INTO plans (name,price,cameras,scan_limit) VALUES (?,?,?,?)", "Free Trial", 0, 2, 200);
    await db.run("INSERT INTO plans (name,price,cameras,scan_limit) VALUES (?,?,?,?)", "Standard", 19.99, 4, 3000);
    await db.run("INSERT INTO plans (name,price,cameras,scan_limit) VALUES (?,?,?,?)", "Premium", 49.99, 10, 10000);
    await db.run("INSERT INTO plans (name,price,cameras,scan_limit) VALUES (?,?,?,?)", "Elite", 99.99, 999, 30000);
  }
}

async function initDb() {
  db = await open({ filename: "./spotalert.db", driver: sqlite3.Database });
  await ensureSchema();
  console.log("✅ SQLite ready");
}

/* =========================
   S3 + SES helpers
========================= */
async function s3Put(key, buffer, contentType = "image/jpeg") {
  const bucket = s3Bucket();
  if (!bucket) throw new Error("S3_BUCKET missing");
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    ACL: "private"
  }));
  return key;
}

async function s3Get(key) {
  const bucket = s3Bucket();
  if (!bucket) throw new Error("S3_BUCKET missing");
  return await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
}

async function s3Del(key) {
  const bucket = s3Bucket();
  if (!bucket) throw new Error("S3_BUCKET missing");
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

async function sendEmail(to, subject, text) {
  if (!process.env.SES_FROM_EMAIL) throw new Error("SES_FROM_EMAIL missing");
  await ses.send(new SendEmailCommand({
    Source: process.env.SES_FROM_EMAIL,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject },
      Body: { Text: { Data: text } }
    }
  }));
}

/* =========================
   RETENTION (100 alerts max, deletes oldest UNPINNED)
========================= */
async function enforceRetention(userEmail) {
  const max = Number(process.env.MAX_ALERTS_PER_USER || 100);
  const cnt = await db.get("SELECT COUNT(*) AS c FROM alerts WHERE user_email=?", userEmail);
  const total = cnt?.c || 0;
  if (total <= max) return;

  const toDelete = total - max;
  const victims = await db.all(
    `SELECT id, image_key FROM alerts
     WHERE user_email=? AND pinned=0
     ORDER BY timestamp ASC
     LIMIT ?`,
    userEmail, toDelete
  );

  for (const v of victims) {
    try { if (v.image_key) await s3Del(v.image_key); } catch {}
    await db.run("DELETE FROM alerts WHERE id=?", v.id);
  }
}

/* =========================
   ZONE RULES + COOLDOWN
========================= */
async function ruleAllows(zoneId, isKnown) {
  if (!zoneId) return true;
  const r = await db.get("SELECT rule_type FROM zone_rules WHERE zone_id=?", zoneId);
  const t = r?.rule_type || "mixed";
  if (t === "mixed") return true;
  if (t === "known_only") return !!isKnown;
  if (t === "unknown_only") return !isKnown;
  return true;
}

async function inCooldown(zoneId) {
  if (!zoneId) return false;
  const r = await db.get("SELECT alert_interval FROM zone_rules WHERE zone_id=?", zoneId);
  const minutes = Number(r?.alert_interval || process.env.UNKNOWN_ALERT_COOLDOWN_MINUTES || 5);
  const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const hit = await db.get(
    `SELECT id FROM alerts
     WHERE zone_id=? AND type='unknown' AND timestamp>=?
     ORDER BY timestamp DESC LIMIT 1`,
    zoneId, since
  );
  return !!hit;
}

/* =========================
   CORE PIPELINE (Rekognition + S3 + DB + Email)
========================= */
async function processAlertPipeline({ userEmail, zoneId, cameraId, imageBuffer, channel }) {
  const email = safeLower(userEmail);
  if (!email) return { ok: false, error: "Missing user email" };

  const bucket = s3Bucket();
  const col = collectionId();
  if (!bucket) return { ok: false, error: "S3_BUCKET missing" };
  if (!col) return { ok: false, error: "REKOG_COLLECTION_ID missing" };

  if (await inCooldown(zoneId)) {
    return { ok: true, skipped: true, reason: "cooldown" };
  }

  let matches = [];
  try {
    const out = await rekognition.send(new SearchFacesByImageCommand({
      CollectionId: col,
      Image: { Bytes: imageBuffer }
    }));
    matches = out.FaceMatches || [];
  } catch (e) {
    console.error("Rekognition search error:", e?.message || e);
    matches = [];
  }

  const isKnown = matches.length > 0;
  if (!(await ruleAllows(zoneId, isKnown))) {
    return { ok: true, skipped: true, reason: "zone_rule_block" };
  }

  let cost = 0.001;
  if (zoneId) {
    const z = await db.get("SELECT cost_per_scan FROM zones WHERE id=?", zoneId);
    if (z?.cost_per_scan != null) cost = Number(z.cost_per_scan);
  }

  const key = `alerts/${email}/${Date.now()}_${crypto.randomBytes(6).toString("hex")}.jpg`;
  await s3Put(key, imageBuffer, "image/jpeg");

  const ins = await db.run(
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

  await enforceRetention(email);

  // Email alert for unknown (real)
  if (!isKnown) {
    const subject = process.env.ALERT_SUBJECT || "[SpotAlert] Unknown Face Detected";
    const dash = `${frontendBase()}/dashboard.html`;
    const text =
`Unknown person detected.

Login to view snapshot:
${dash}

Alert ID: ${ins.lastID}
Zone: ${zoneId || "N/A"}
Time: ${nowIso()}`;
    try {
      await sendEmail(email, subject, text);
    } catch (e) {
      console.error("SES alert email failed:", e?.message || e);
    }
  }

  return { ok: true, alert_id: ins.lastID, type: isKnown ? "known" : "unknown", cost, image_key: key, faces: matches };
}

/* =========================
   HEALTH
========================= */
app.get("/", (req, res) => res.json({ ok: true, service: "spotalert-backend", time: nowIso() }));
app.get("/api/status", (req, res) => res.json({ ok: true, time: nowIso() }));

/* =========================
   AUTH (REAL email verify)
========================= */
app.post("/api/auth/signup", async (req, res) => {
  try {
    requireEnv("JWT_SECRET");
    const name = String(req.body.name || "").trim();
    const email = safeLower(req.body.email);
    const password = String(req.body.password || "");
    if (!name || !email || !password) return res.status(400).json({ error: "All fields required" });

    const exists = await db.get("SELECT id FROM users WHERE email=?", email);
    if (exists) return res.status(409).json({ error: "Email already exists" });

    const hash = await bcrypt.hash(password, 10);
    const verifyToken = crypto.randomBytes(20).toString("hex");
    const trialEnd = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

    await db.run(
      `INSERT INTO users (name,email,password_hash,plan,trial_end,verify_token,email_verified,disabled)
       VALUES (?,?,?,?,?,?,?,?)`,
      name, email, hash, "Free Trial", trialEnd, verifyToken, 0, 0
    );

    // send verification email (REAL)
    const link = `${frontendBase()}/verify.html?token=${verifyToken}`;
    try {
      await sendEmail(email, "Verify your SpotAlert account", `Verify your SpotAlert account:\n\n${link}\n\nIf you did not create this account, ignore this email.`);
    } catch (e) {
      return res.status(500).json({ error: "Signup saved, but verification email failed. Check SES_FROM_EMAIL + SES verification." });
    }

    return res.json({ ok: true, message: "Signup successful. Please verify your email." });
  } catch (e) {
    console.error("signup error:", e);
    return res.status(500).json({ error: "Signup failed" });
  }
});

app.post("/api/auth/verify", async (req, res) => {
  try {
    const token = String(req.body.token || "").trim();
    if (!token) return res.status(400).json({ error: "Missing token" });

    const u = await db.get("SELECT id FROM users WHERE verify_token=?", token);
    if (!u) return res.status(400).json({ error: "Invalid token" });

    await db.run("UPDATE users SET verify_token=NULL, email_verified=1 WHERE id=?", u.id);
    return res.json({ ok: true });
  } catch (e) {
    console.error("verify error:", e);
    return res.status(500).json({ error: "Verification failed" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    requireEnv("JWT_SECRET");
    const email = safeLower(req.body.email);
    const password = String(req.body.password || "");
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });

    const user = await db.get("SELECT * FROM users WHERE email=?", email);
    if (!user) return res.status(401).json({ error: "Invalid credentials" });
    if (user.disabled) return res.status(403).json({ error: "Account disabled" });
    if (!user.email_verified) return res.status(403).json({ error: "Email not verified" });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    const token = signToken({ email: user.email, plan: user.plan });
    return res.json({ token, user: { name: user.name, email: user.email, plan: user.plan } });
  } catch (e) {
    console.error("login error:", e);
    return res.status(500).json({ error: "Login failed" });
  }
});

app.post("/api/auth/request-reset", async (req, res) => {
  try {
    const email = safeLower(req.body.email);
    if (!email) return res.json({ ok: true });

    const user = await db.get("SELECT id FROM users WHERE email=?", email);
    if (!user) return res.json({ ok: true });

    const token = crypto.randomBytes(20).toString("hex");
    const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    await db.run("UPDATE users SET reset_token=?, reset_expires=? WHERE id=?", token, expires, user.id);

    const link = `${frontendBase()}/reset.html?token=${token}`;
    try {
      await sendEmail(email, "Reset your SpotAlert password", `Reset your SpotAlert password:\n\n${link}\n\nIf you did not request this, ignore this email.`);
    } catch (e) {
      return res.status(500).json({ error: "Reset token saved, but email failed. Check SES." });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("request-reset error:", e);
    return res.status(500).json({ error: "Request reset failed" });
  }
});

app.post("/api/auth/reset", async (req, res) => {
  try {
    const token = String(req.body.token || "").trim();
    const password = String(req.body.password || "");
    if (!token || !password) return res.status(400).json({ error: "Missing token or password" });

    const u = await db.get("SELECT id, reset_expires FROM users WHERE reset_token=?", token);
    if (!u) return res.status(400).json({ error: "Invalid token" });

    if (u.reset_expires && Date.now() > new Date(u.reset_expires).getTime()) {
      return res.status(400).json({ error: "Token expired" });
    }

    const hash = await bcrypt.hash(password, 10);
    await db.run("UPDATE users SET password_hash=?, reset_token=NULL, reset_expires=NULL WHERE id=?", hash, u.id);
    return res.json({ ok: true });
  } catch (e) {
    console.error("reset error:", e);
    return res.status(500).json({ error: "Reset failed" });
  }
});

/* =========================
   ADMIN
========================= */
app.post("/api/admin/login", (req, res) => {
  try {
    requireEnv("JWT_SECRET");
    requireEnv("ADMIN_USER");
    requireEnv("ADMIN_PASS");
    const { username, password } = req.body || {};
    if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
      const token = jwt.sign({ role: "admin" }, process.env.JWT_SECRET, { expiresIn: "12h" });
      return res.json({ ok: true, token });
    }
    return res.status(401).json({ error: "Invalid admin credentials" });
  } catch (e) {
    return res.status(500).json({ error: "Admin env missing" });
  }
});

app.get("/api/admin/users", adminAuth, async (req, res) => {
  const users = await db.all(`SELECT id,name,email,plan,trial_end,created_at,email_verified,disabled FROM users ORDER BY created_at DESC LIMIT 500`);
  res.json({ ok: true, users });
});

/* =========================
   PLANS
========================= */
app.get("/api/plans", async (req, res) => {
  const plans = await db.all("SELECT id,name,price,cameras,scan_limit FROM plans ORDER BY price ASC");
  res.json(plans);
});

/* =========================
   LOCATIONS
========================= */
app.post("/api/locations", auth, async (req, res) => {
  const email = safeLower(req.user.email);
  const name = String(req.body.name || "").trim();
  const address = String(req.body.address || "").trim();
  if (!name) return res.status(400).json({ error: "Name required" });
  const r = await db.run("INSERT INTO locations (user_email,name,address) VALUES (?,?,?)", email, name, address);
  res.json({ ok: true, id: r.lastID });
});

app.get("/api/locations", auth, async (req, res) => {
  const email = safeLower(req.user.email);
  const rows = await db.all("SELECT id,name,address,created_at FROM locations WHERE user_email=? ORDER BY created_at DESC", email);
  res.json(rows);
});

/* =========================
   ZONES + RULES
========================= */
app.post("/api/zones", auth, async (req, res) => {
  const email = safeLower(req.user.email);
  const location_id = Number(req.body.location_id);
  const name = String(req.body.name || "").trim();
  const cost_per_scan = Number(req.body.cost_per_scan || 0.001);
  const active_hours = req.body.active_hours ? JSON.stringify(req.body.active_hours) : null;

  if (!location_id || !name) return res.status(400).json({ error: "Missing fields" });

  const loc = await db.get("SELECT id FROM locations WHERE id=? AND user_email=?", location_id, email);
  if (!loc) return res.status(403).json({ error: "Forbidden" });

  const r = await db.run("INSERT INTO zones (location_id,name,cost_per_scan,active_hours) VALUES (?,?,?,?)", location_id, name, cost_per_scan, active_hours);
  await db.run("INSERT OR IGNORE INTO zone_rules (zone_id,rule_type,alert_interval) VALUES (?,?,?)", r.lastID, "unknown_only", Number(process.env.UNKNOWN_ALERT_COOLDOWN_MINUTES || 5));
  res.json({ ok: true, id: r.lastID });
});

app.get("/api/zones", auth, async (req, res) => {
  const email = safeLower(req.user.email);
  const rows = await db.all(`
    SELECT z.id,z.location_id,z.name,z.cost_per_scan,z.active_hours,z.created_at,l.name AS location_name
    FROM zones z
    JOIN locations l ON l.id=z.location_id
    WHERE l.user_email=?
    ORDER BY z.created_at DESC`, email);
  res.json(rows);
});

app.post("/api/zone-rules", auth, async (req, res) => {
  const email = safeLower(req.user.email);
  const zone_id = Number(req.body.zone_id);
  const rule_type = String(req.body.rule_type || "").trim();
  const alert_interval = Number(req.body.alert_interval || 10);

  const allowed = ["known_only", "unknown_only", "mixed"];
  if (!zone_id || !allowed.includes(rule_type)) return res.status(400).json({ error: "Invalid rule" });

  const z = await db.get(`
    SELECT z.id FROM zones z
    JOIN locations l ON l.id=z.location_id
    WHERE z.id=? AND l.user_email=?`, zone_id, email);
  if (!z) return res.status(403).json({ error: "Forbidden" });

  await db.run(
    `INSERT INTO zone_rules (zone_id,rule_type,alert_interval)
     VALUES (?,?,?)
     ON CONFLICT(zone_id) DO UPDATE SET rule_type=excluded.rule_type, alert_interval=excluded.alert_interval`,
    zone_id, rule_type, alert_interval
  );

  res.json({ ok: true });
});

/* =========================
   CAMERAS + CCTV INGEST
========================= */
app.post("/api/camera/register", auth, async (req, res) => {
  const email = safeLower(req.user.email);
  const name = String(req.body.name || "").trim();
  const location = String(req.body.location || "").trim();
  const ip = String(req.body.ip || "").trim();
  const zone_id = req.body.zone_id ? Number(req.body.zone_id) : null;
  if (!name) return res.status(400).json({ error: "Camera name required" });

  if (zone_id) {
    const z = await db.get(`
      SELECT z.id FROM zones z
      JOIN locations l ON l.id=z.location_id
      WHERE z.id=? AND l.user_email=?`, zone_id, email);
    if (!z) return res.status(403).json({ error: "Invalid zone" });
  }

  const api_key = crypto.randomBytes(18).toString("hex");
  const r = await db.run(
    "INSERT INTO cameras (user_email,name,location,ip,zone_id,api_key) VALUES (?,?,?,?,?,?)",
    email, name, location, ip, zone_id, api_key
  );
  res.json({ ok: true, cameraId: r.lastID, api_key });
});

app.get("/api/camera/list", auth, async (req, res) => {
  const email = safeLower(req.user.email);
  const rows = await db.all("SELECT id,name,location,ip,zone_id,created_at FROM cameras WHERE user_email=? ORDER BY created_at DESC", email);
  res.json(rows);
});

app.post("/api/cctv/:id/snapshot", upload.single("image"), async (req, res) => {
  try {
    const cameraKey = String(req.headers["x-camera-key"] || "");
    if (!cameraKey) return res.status(401).json({ error: "Missing X-Camera-Key" });
    if (!req.file?.buffer) return res.status(400).json({ error: "Missing image file" });

    const cameraId = Number(req.params.id);
    const cam = await db.get("SELECT id,user_email,api_key,zone_id FROM cameras WHERE id=?", cameraId);
    if (!cam) return res.status(404).json({ error: "Camera not found" });
    if (String(cam.api_key) !== String(cameraKey)) return res.status(403).json({ error: "Invalid camera key" });

    const result = await processAlertPipeline({
      userEmail: cam.user_email,
      zoneId: cam.zone_id || null,
      cameraId: cam.id,
      imageBuffer: req.file.buffer,
      channel: "cctv"
    });

    res.json(result);
  } catch (e) {
    console.error("cctv ingest error:", e);
    res.status(500).json({ error: "Snapshot ingest failed" });
  }
});

/* =========================
   ALERTS (list/image/delete/pin)
========================= */
app.get("/api/alerts/list", auth, async (req, res) => {
  const email = safeLower(req.user.email);
  const type = safeLower(req.query.type || "unknown");

  const base = apiBase();
  let rows;
  if (type === "all") {
    rows = await db.all(`SELECT id,type,image_key,channel,cost,zone_id,camera_id,pinned,timestamp FROM alerts WHERE user_email=? ORDER BY timestamp DESC LIMIT 200`, email);
  } else {
    rows = await db.all(`SELECT id,type,image_key,channel,cost,zone_id,camera_id,pinned,timestamp FROM alerts WHERE user_email=? AND type=? ORDER BY timestamp DESC LIMIT 200`, email, type);
  }

  res.json(rows.map(r => ({
    ...r,
    image_url: r.image_key ? `${base}/api/alerts/${r.id}/image` : null
  })));
});

app.get("/api/alerts/:id/image", auth, async (req, res) => {
  try {
    const email = safeLower(req.user.email);
    const id = Number(req.params.id);
    const row = await db.get("SELECT id,user_email,image_key FROM alerts WHERE id=?", id);
    if (!row) return res.status(404).json({ error: "Not found" });
    if (safeLower(row.user_email) !== email) return res.status(403).json({ error: "Forbidden" });
    if (!row.image_key) return res.status(404).json({ error: "No image" });

    const out = await s3Get(row.image_key);
    res.setHeader("Content-Type", out.ContentType || "image/jpeg");
    res.setHeader("Cache-Control", "no-store");
    streamToRes(out.Body, res);
  } catch (e) {
    console.error("alert image error:", e);
    res.status(500).json({ error: "Failed to load image" });
  }
});

app.post("/api/alerts/:id/pin", auth, async (req, res) => {
  const email = safeLower(req.user.email);
  const id = Number(req.params.id);
  const pinned = req.body.pinned ? 1 : 0;

  const row = await db.get("SELECT id,user_email FROM alerts WHERE id=?", id);
  if (!row) return res.status(404).json({ error: "Not found" });
  if (safeLower(row.user_email) !== email) return res.status(403).json({ error: "Forbidden" });

  await db.run("UPDATE alerts SET pinned=? WHERE id=?", pinned, id);
  res.json({ ok: true, pinned });
});

app.delete("/api/alerts/:id", auth, async (req, res) => {
  const email = safeLower(req.user.email);
  const id = Number(req.params.id);

  const row = await db.get("SELECT id,user_email,image_key FROM alerts WHERE id=?", id);
  if (!row) return res.status(404).json({ error: "Not found" });
  if (safeLower(row.user_email) !== email) return res.status(403).json({ error: "Forbidden" });

  try { if (row.image_key) await s3Del(row.image_key); } catch {}
  await db.run("DELETE FROM alerts WHERE id=?", id);
  res.json({ ok: true });
});

/* =========================
   MANUAL TRIGGER (for front testing)
========================= */
app.post("/api/trigger-alert", upload.single("image"), async (req, res) => {
  try {
    if (!req.file?.buffer) return res.status(400).json({ error: "Missing image file" });
    const email = safeLower(req.body.email);
    const zoneId = req.body.zone_id ? Number(req.body.zone_id) : null;
    const cameraId = req.body.camera_id ? Number(req.body.camera_id) : null;
    if (!email) return res.status(400).json({ error: "Missing email" });

    const result = await processAlertPipeline({
      userEmail: email,
      zoneId,
      cameraId,
      imageBuffer: req.file.buffer,
      channel: "email"
    });

    res.json(result);
  } catch (e) {
    console.error("trigger error:", e);
    res.status(500).json({ error: "Alert processing failed" });
  }
});

/* =========================
   KNOWN FACES (S3 + IndexFaces)
========================= */
app.post("/api/known_faces", auth, async (req, res) => {
  const email = safeLower(req.user.email);
  const first_name = String(req.body.first_name || "").trim();
  const last_name = String(req.body.last_name || "").trim();
  if (!first_name || !last_name) return res.status(400).json({ error: "Missing name" });

  const r = await db.run("INSERT INTO known_faces (user_email,first_name,last_name) VALUES (?,?,?)", email, first_name, last_name);
  res.json({ ok: true, id: r.lastID });
});

app.get("/api/known_faces", auth, async (req, res) => {
  const email = safeLower(req.user.email);
  const rows = await db.all("SELECT id,first_name,last_name,created_at FROM known_faces WHERE user_email=? ORDER BY created_at DESC", email);
  res.json(rows);
});

app.post("/api/known_faces/:id/image", auth, upload.single("image"), async (req, res) => {
  try {
    const email = safeLower(req.user.email);
    const knownId = Number(req.params.id);
    if (!knownId) return res.status(400).json({ error: "Invalid id" });
    if (!req.file?.buffer) return res.status(400).json({ error: "Missing image file" });

    const bucket = s3Bucket();
    const col = collectionId();
    if (!bucket) return res.status(500).json({ error: "S3_BUCKET missing" });
    if (!col) return res.status(500).json({ error: "REKOG_COLLECTION_ID missing" });

    const person = await db.get("SELECT id FROM known_faces WHERE id=? AND user_email=?", knownId, email);
    if (!person) return res.status(404).json({ error: "Not found" });

    const key = `known_faces/${email}/${knownId}/${Date.now()}_${crypto.randomBytes(6).toString("hex")}.jpg`;
    await s3Put(key, req.file.buffer, req.file.mimetype || "image/jpeg");

    let faceId = null;
    try {
      const idx = await rekognition.send(new IndexFacesCommand({
        CollectionId: col,
        Image: { S3Object: { Bucket: bucket, Name: key } },
        ExternalImageId: `${email}:${knownId}`,
        DetectionAttributes: []
      }));
      faceId = idx?.FaceRecords?.[0]?.Face?.FaceId || null;
    } catch (e) {
      console.error("IndexFaces failed:", e?.message || e);
    }

    await db.run("INSERT INTO known_face_images (known_face_id, face_id, s3_key) VALUES (?,?,?)", knownId, faceId, key);
    res.json({ ok: true, s3_key: key, face_id: faceId });
  } catch (e) {
    console.error("known face upload error:", e);
    res.status(500).json({ error: "Failed" });
  }
});

app.delete("/api/known_faces/:id", auth, async (req, res) => {
  try {
    const email = safeLower(req.user.email);
    const knownId = Number(req.params.id);

    const person = await db.get("SELECT id FROM known_faces WHERE id=? AND user_email=?", knownId, email);
    if (!person) return res.status(404).json({ error: "Not found" });

    const imgs = await db.all("SELECT face_id, s3_key FROM known_face_images WHERE known_face_id=?", knownId);

    const col = collectionId();
    if (col) {
      const faceIds = imgs.map(i => i.face_id).filter(Boolean);
      if (faceIds.length) {
        try {
          await rekognition.send(new DeleteFacesCommand({ CollectionId: col, FaceIds: faceIds }));
        } catch (e) {
          console.warn("DeleteFaces warn:", e?.message || e);
        }
      }
    }

    for (const i of imgs) {
      if (i.s3_key) {
        try { await s3Del(i.s3_key); } catch {}
      }
    }

    await db.run("DELETE FROM known_face_images WHERE known_face_id=?", knownId);
    await db.run("DELETE FROM known_faces WHERE id=?", knownId);
    res.json({ ok: true });
  } catch (e) {
    console.error("delete known face error:", e);
    res.status(500).json({ error: "Failed" });
  }
});

/* =========================
   BILLING (Stripe checkout)
========================= */
app.post("/api/billing/create-checkout-session", auth, async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: "Stripe not configured" });

    const email = safeLower(req.user.email);
    const plan = String(req.body.plan || "").trim();
    if (!plan) return res.status(400).json({ error: "Missing plan" });

    const map = {
      Standard: process.env.STRIPE_PRICE_STANDARD,
      Premium: process.env.STRIPE_PRICE_PREMIUM,
      Elite: process.env.STRIPE_PRICE_ELITE
    };
    if (!map[plan]) return res.status(400).json({ error: "Invalid plan" });

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      customer_email: email,
      line_items: [{ price: map[plan], quantity: 1 }],
      metadata: { plan, email },
      success_url: `${frontendBase()}/dashboard.html?payment=success`,
      cancel_url: `${frontendBase()}/plans.html?payment=cancel`
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error("stripe error:", e);
    res.status(500).json({ error: "Checkout failed" });
  }
});

/* =========================
   BOOT
========================= */
const PORT = process.env.PORT || 3000;

await initDb();

app.listen(PORT, () => {
  console.log(`🚀 SpotAlert backend running on port ${PORT}`);
  console.log(`FRONTEND_URL=${process.env.FRONTEND_URL || ""}`);
  console.log(`API_BASE_URL=${process.env.API_BASE_URL || ""}`);
  console.log(`S3_BUCKET=${s3Bucket() || "(missing)"}`);
  console.log(`REKOG_COLLECTION_ID=${collectionId() || "(missing)"}`);
});
EOF
npm install --silent && \
pm2 delete spotalert 2>/dev/null || true && \
pm2 start server.js --name spotalert && \
pm2 save && \
pm2 logs spotalert --lines 80
