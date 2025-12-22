// server.js — SpotAlert FULL backend (SQLite + AWS + Auth + Zones + Cost SAFE + Snapshot Storage)
// ✅ FIXED: underscore route names + removed route-path confusion + added missing DB tables safely
// ✅ FIXED: timezone route now truly matches POST /api/timezone (not /api/timezone/timezone)
// ✅ ADDED: save snapshot images locally (./uploads) so dashboard can show “who” (Option A)
// ✅ SAFE: does NOT crash if AWS/SES missing; keeps running

import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import fs from "fs";
import path from "path";

// AWS
import {
  RekognitionClient,
  SearchFacesByImageCommand
} from "@aws-sdk/client-rekognition";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

// ROUTES (underscore only)
import adminRoutes from "./routes/admin.js";
import authoritiesRoutes from "./routes/authorities.js";
import cameraRoutes from "./routes/camera.js";
import verifyRoutes from "./routes/verify.js";
import knownFacesRoutes from "./routes/known_faces.js";

// ✅ NEW: locations + zones + cost (underscore + consistent names)
import locationRoutes from "./routes/locations.js";
import zoneRoutes from "./routes/zone.js";
import costRoutes from "./routes/cost.js";

// ✅ OPTIONAL but recommended if you have it
// (If you don't have these files, DO NOT import them)
// import zoneRulesRoutes from "./routes/zone_rules.js";
// import alertsRoutes from "./routes/alerts.js";

dotenv.config();

const app = express();

// ✅ EC2/NGINX SSL FIX (certificate installed on NGINX)
app.set("trust proxy", 1);

// ✅ Body parsing
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ✅ CORS
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

// ---------- Multer (memory) ----------
const upload = multer({ storage: multer.memoryStorage() });

// ---------- AWS clients (SAFE) ----------
const rekognition = new RekognitionClient({
  region: process.env.AWS_REGION || "us-east-1"
});
const ses = new SESClient({
  region: process.env.AWS_REGION || "us-east-1"
});

// ---------- Snapshot storage (Option A) ----------
const UPLOAD_DIR = path.resolve("./uploads");
try {
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
} catch (e) {
  console.error("Could not create uploads dir:", e);
}

// ---------- SQLite ----------
let db;

async function columnExists(table, column) {
  const cols = await db.all(`PRAGMA table_info(${table})`);
  return cols.some((c) => c.name === column);
}

async function tableExists(tableName) {
  const r = await db.get(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
    tableName
  );
  return !!r;
}

async function initDb() {
  db = await open({
    filename: "./spotalert.db",
    driver: sqlite3.Database
  });

  // Base schema
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'free',
      trial_end DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      reset_token TEXT,
      reset_expires DATETIME
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_email TEXT NOT NULL,
      type TEXT NOT NULL,
      image_key TEXT,
      channel TEXT NOT NULL,
      cost REAL NOT NULL DEFAULT 0,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      price REAL,
      cameras INTEGER,
      scan_limit INTEGER
    );

    -- cameras table (required by routes/camera.js)
    CREATE TABLE IF NOT EXISTS cameras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_email TEXT NOT NULL,
      name TEXT NOT NULL,
      ip TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Known faces tables (required by routes/known_faces.js)
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
      FOREIGN KEY (known_face_id) REFERENCES known_faces(id)
    );

    -- ✅ LOCATIONS (properties like house/cottage/plant)
    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_email TEXT NOT NULL,
      name TEXT NOT NULL,
      address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ✅ ZONES (per location)
    CREATE TABLE IF NOT EXISTS zones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      cost_per_scan REAL NOT NULL DEFAULT 0.001,
      active_hours TEXT, -- JSON string (optional)
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (location_id) REFERENCES locations(id)
    );
  `);

  // ✅ ADD zone_id columns safely
  if (!(await columnExists("cameras", "zone_id"))) {
    await db.exec(`ALTER TABLE cameras ADD COLUMN zone_id INTEGER;`);
  }
  if (!(await columnExists("alerts", "zone_id"))) {
    await db.exec(`ALTER TABLE alerts ADD COLUMN zone_id INTEGER;`);
  }

  // ✅ Zone rules table (needed for “allowed person / time zone rules” logic)
  if (!(await tableExists("zone_rules"))) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS zone_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        zone_id INTEGER UNIQUE,
        rule_type TEXT NOT NULL DEFAULT 'unknown_only',
        alert_interval INTEGER NOT NULL DEFAULT 10,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (zone_id) REFERENCES zones(id)
      );
    `);
  }

  // ✅ Usage costs table (needed if cost route expects it)
  if (!(await tableExists("usage_costs"))) {
    await db.exec(`
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
  }

  // Seed plans if empty
  const row = await db.get("SELECT COUNT(*) as cnt FROM plans");
  if (row?.cnt === 0) {
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
      149.99,
      20,
      30000
    );
  }

  // Share handles for routes
  app.set("db", db);
  app.set("rekognition", rekognition);
  app.set("ses", ses);

  console.log("✅ SQLite initialised");
}

// ---------- JWT auth middleware ----------
function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    if (!process.env.JWT_SECRET) {
      return res.status(500).json({ error: "Server missing JWT_SECRET" });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// =======================================================
// HEALTH CHECKS
// =======================================================
app.get("/", (req, res) => {
  res.json({ status: "SpotAlert backend running" });
});

app.get("/api/status", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// =======================================================
// AUTH — SIGNUP / LOGIN / RESET
// =======================================================
async function handleSignup(req, res) {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: "All fields are required." });
    }

    const existing = await db.get(
      "SELECT id FROM users WHERE email = ?",
      email.toLowerCase()
    );
    if (existing) {
      return res.status(409).json({ error: "Email already registered." });
    }

    const hash = await bcrypt.hash(password, 10);
    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + 14);

    await db.run(
      `INSERT INTO users (name,email,password_hash,plan,trial_end)
       VALUES (?,?,?,?,?)`,
      name,
      email.toLowerCase(),
      hash,
      "Free Trial",
      trialEnd.toISOString()
    );

    const token = jwt.sign(
      { email: email.toLowerCase(), plan: "Free Trial" },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );

    return res.json({
      token,
      user: { name, email: email.toLowerCase(), plan: "Free Trial" }
    });
  } catch (err) {
    console.error("Signup error:", err);
    return res.status(500).json({ error: "Signup failed." });
  }
}

app.post("/api/signup", handleSignup);
app.post("/api/auth/signup", handleSignup);

async function handleLogin(req, res) {
  try {
    const { email, password } = req.body;

    const user = await db.get(
      "SELECT * FROM users WHERE email = ?",
      (email || "").toLowerCase()
    );
    if (!user) return res.status(401).json({ error: "Invalid credentials." });

    const ok = await bcrypt.compare(password || "", user.password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials." });

    const token = jwt.sign(
      { email: user.email, plan: user.plan },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );

    return res.json({
      token,
      user: { name: user.name, email: user.email, plan: user.plan }
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Login failed." });
  }
}

app.post("/api/auth/login", handleLogin);
app.post("/api/login", handleLogin);

// RESET PASSWORD (token is logged only; email sending handled in routes if you use SES auth route)
app.post("/api/auth/request-reset", async (req, res) => {
  try {
    const email = (req.body.email || "").toLowerCase();
    const user = await db.get("SELECT * FROM users WHERE email = ?", email);
    if (!user) return res.json({ ok: true });

    const token = Math.random().toString(36).slice(2, 10);
    const expires = new Date(Date.now() + 60 * 60 * 1000);

    await db.run(
      "UPDATE users SET reset_token=?, reset_expires=? WHERE email=?",
      token,
      expires.toISOString(),
      email
    );

    console.log("Reset token:", token);
    return res.json({ ok: true });
  } catch (err) {
    console.error("request-reset error:", err);
    return res.status(500).json({ error: "Could not create reset token." });
  }
});

// =======================================================
// ALERT SYSTEM — UPLOAD + REKOGNITION (zone + cost + snapshot saved)
// =======================================================

// Simple face search endpoint (optional)
app.post("/upload", upload.single("image"), async (req, res) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ error: "Missing image file." });
    }

    const response = await rekognition.send(
      new SearchFacesByImageCommand({
        CollectionId: process.env.REKOG_COLLECTION_ID,
        Image: { Bytes: req.file.buffer }
      })
    );

    return res.json(response);
  } catch (error) {
    console.error("Rekognition Error:", error);
    return res.status(500).json({ error: "Face search failed" });
  }
});

// Trigger alert (saves snapshot locally + records cost + emails)
app.post("/api/trigger-alert", upload.single("image"), async (req, res) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ error: "Missing image file." });
    }

    const email = (req.body.email || "").toLowerCase();
    const zoneId = req.body.zone_id ? Number(req.body.zone_id) : null;

    // 1) Rekognition match check (SAFE)
    let matches = [];
    try {
      const rekogRes = await rekognition.send(
        new SearchFacesByImageCommand({
          CollectionId: process.env.REKOG_COLLECTION_ID,
          Image: { Bytes: req.file.buffer }
        })
      );
      matches = rekogRes.FaceMatches || [];
    } catch (e) {
      console.error("Rekognition send failed:", e);
    }

    const isKnown = matches.length > 0;

    // 2) Cost (zone-aware)
    let cost = 0.001;
    if (zoneId) {
      const zone = await db.get(
        "SELECT cost_per_scan FROM zones WHERE id=?",
        zoneId
      );
      if (zone?.cost_per_scan != null) cost = Number(zone.cost_per_scan);
    }

    // 3) Save snapshot locally (Option A)
    //    Store as jpg file in ./uploads and store absolute file path in alerts.image_key
    let savedPath = null;
    try {
      const now = Date.now();
      const safeEmail = (email || "unknown").replace(/[^a-z0-9@._-]/gi, "_");
      const filename = `alert_${safeEmail}_${now}.jpg`;
      const filePath = path.join(UPLOAD_DIR, filename);
      fs.writeFileSync(filePath, req.file.buffer);
      savedPath = filePath;
    } catch (e) {
      console.error("Saving snapshot failed:", e);
      // do not crash — continue
      savedPath = null;
    }

    // 4) Insert alert row
    const insert = await db.run(
      `INSERT INTO alerts (user_email,type,image_key,channel,cost,zone_id)
       VALUES (?,?,?,?,?,?)`,
      email || "unknown@spotalert.live",
      isKnown ? "known" : "unknown",
      savedPath, // local file path
      "email",
      cost,
      zoneId
    );

    const alertId = insert?.lastID;

    // 5) Email (SAFE) — includes dashboard link
    //    Image is available in dashboard via /api/alerts/:id/image (below)
    if (!isKnown && email) {
      try {
        if (process.env.SES_FROM_EMAIL) {
          await ses.send(
            new SendEmailCommand({
              Source: process.env.SES_FROM_EMAIL,
              Destination: { ToAddresses: [email] },
              Message: {
                Subject: {
                  Data: process.env.ALERT_SUBJECT || "SpotAlert Alert"
                },
                Body: {
                  Text: {
                    Data:
`Unknown person detected.

View snapshot:
- Login then open dashboard alerts (recommended)
- Or use API (requires token):
  ${process.env.API_BASE_URL || ""}/api/alerts/${alertId}/image

Zone: ${zoneId || "N/A"}
Time: ${new Date().toISOString()}`
                  }
                }
              }
            })
          );
        }
      } catch (e) {
        console.error("SES send failed:", e);
      }
    }

    return res.json({
      ok: true,
      alert_id: alertId,
      type: isKnown ? "known" : "unknown",
      faces: matches,
      cost,
      zone_id: zoneId,
      image_saved: !!savedPath
    });
  } catch (err) {
    console.error("trigger-alert error:", err);
    return res.status(500).json({ error: "Alert processing failed." });
  }
});

// =======================================================
// PLANS + USAGE
// =======================================================
app.get("/api/plans", async (req, res) => {
  try {
    const plans = await db.all(
      "SELECT id,name,price,cameras,scan_limit FROM plans ORDER BY price ASC"
    );
    return res.json(plans);
  } catch (err) {
    return res.status(500).json({ error: "Could not load plans." });
  }
});

// Simple cost summary (kept)
app.get("/api/usage-summary", async (req, res) => {
  try {
    const email = (req.query.email || "").toLowerCase();
    const month = new Date().toISOString().slice(0, 7);

    const rows = await db.all(
      `SELECT channel,COUNT(*) as count,SUM(cost) as total
       FROM alerts
       WHERE user_email=? AND strftime('%Y-%m',timestamp)=?
       GROUP BY channel`,
      email,
      month
    );

    const total = rows.reduce((s, r) => s + (r.total || 0), 0);

    return res.json({
      month,
      total_cost_usd: Number(total.toFixed(3)),
      details: rows.map((r) => ({
        channel: r.channel,
        count: r.count,
        total: Number((r.total || 0).toFixed(3))
      }))
    });
  } catch (err) {
    return res.status(500).json({ error: "Could not load usage." });
  }
});

// =======================================================
// ELITE REPLAY
// =======================================================
app.get("/api/elite/replay", async (req, res) => {
  try {
    const minutes = Number(req.query.minutes || 10);
    const since = new Date(Date.now() - minutes * 60000).toISOString();

    const rows = await db.all(
      `SELECT id,type,image_key as image,timestamp
       FROM alerts WHERE timestamp>=?
       ORDER BY timestamp DESC LIMIT 20`,
      since
    );

    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: "Replay load failed" });
  }
});

app.get("/api/elite/frame-url", (req, res) => {
  return res.json({
    url: "cctv_background.png",
    key: req.query.key || ""
  });
});

app.get("/api/elite/incident-pdf", (req, res) => {
  res.setHeader("Content-Type", "application/pdf");
  return res.send(
    Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF", "utf8")
  );
});

// =======================================================
// ALERT IMAGE VIEW (Option A) — requires JWT token
// GET /api/alerts/:id/image
// =======================================================
app.get("/api/alerts/:id/image", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid id" });

    const email = (req.user.email || "").toLowerCase();

    const row = await db.get(
      `SELECT id,user_email,image_key FROM alerts WHERE id=?`,
      id
    );

    if (!row) return res.status(404).json({ error: "Not found" });
    if ((row.user_email || "").toLowerCase() !== email) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (!row.image_key) return res.status(404).json({ error: "No image" });

    const filePath = path.resolve(row.image_key);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Missing file" });
    }

    res.setHeader("Content-Type", "image/jpeg");
    return fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    console.error("alert image error:", e);
    return res.status(500).json({ error: "Failed to load image" });
  }
});

// =======================================================
// TIMEZONE ROUTE FIX (IMPORTANT)
// Your timezone.js uses router.post("/timezone") expecting /api/timezone
// So we mount it at /api (not /api/timezone)
// =======================================================

// =======================================================
// ROUTES FOR FRONTEND (ALL WIRED + UNDERSCORE NAMES)
// =======================================================
app.use("/api/admin", adminRoutes);
app.use("/api/authorities", authoritiesRoutes);
app.use("/api/camera", cameraRoutes);

// ✅ FIXED: mount timezone at /api so POST /api/timezone works
// timezoneRoutes should define: router.post("/timezone") and router.post("/log-event")
import timezoneRoutes from "./routes/timezone.js";
app.use("/api", timezoneRoutes);

app.use("/api/verify", verifyRoutes);
app.use("/api/known_faces", knownFacesRoutes);

// ✅ NEW: LOCATIONS + ZONES + COST
app.use("/api/locations", locationRoutes);
app.use("/api/zones", zoneRoutes);
app.use("/api/cost", costRoutes);

// =======================================================
// START SERVER
// =======================================================
const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 SpotAlert backend running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to init DB:", err);
    process.exit(1);
  });

export default app;
