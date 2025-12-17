// server.js — SpotAlert FULL backend (SQLite + AWS + Auth)

import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

// AWS
import {
  RekognitionClient,
  SearchFacesByImageCommand
} from "@aws-sdk/client-rekognition";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

// ROUTES (ALL YOUR ROUTES + KNOWN FACES)
import adminRoutes from "./routes/admin.js";
import authoritiesRoutes from "./routes/authorities.js";
import cameraRoutes from "./routes/camera.js";
import timezoneRoutes from "./routes/timezone.js";
import verifyRoutes from "./routes/verify.js";
import knownFacesRoutes from "./routes/known-faces.js";

dotenv.config();

const app = express();

// ✅ EC2/NGINX SSL FIX (certificate was installed on NGINX)
app.set("trust proxy", 1);

// ✅ EC2 FIX: camera connector sometimes posts urlencoded body
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ✅ EC2 FIX: correct CORS (avoid random issues)
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

// ---------- Multer for in-memory image uploads ----------
const upload = multer({ storage: multer.memoryStorage() });

// ---------- AWS clients ----------
const rekognition = new RekognitionClient({ region: process.env.AWS_REGION });
const ses = new SESClient({ region: process.env.AWS_REGION });

// ---------- SQLite setup ----------
let db;

async function initDb() {
  db = await open({
    filename: "./spotalert.db",
    driver: sqlite3.Database
  });

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

    -- ✅ ADDED: cameras table (required by routes/camera.js)
    CREATE TABLE IF NOT EXISTS cameras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_email TEXT NOT NULL,
      name TEXT NOT NULL,
      ip TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ✅ ADDED: Known faces tables (required by routes/known-faces.js)
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
  `);

  const row = await db.get("SELECT COUNT(*) as cnt FROM plans");
  if (row.cnt === 0) {
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

  // ✅ REQUIRED: share DB + Rekognition so routes can use them
  app.set("db", db);
  app.set("rekognition", rekognition);

  console.log("✅ SQLite initialised");
}

// ---------- JWT auth middleware ----------
function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (e) {
    res.status(401).json({ error: "Invalid token" });
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
    if (!name || !email || !password)
      return res.status(400).json({ error: "All fields are required." });

    const existing = await db.get(
      "SELECT id FROM users WHERE email = ?",
      email.toLowerCase()
    );
    if (existing) return res.status(409).json({ error: "Email already registered." });

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

    res.json({
      token,
      user: { name, email: email.toLowerCase(), plan: "Free Trial" }
    });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ error: "Signup failed." });
  }
}

app.post("/api/signup", handleSignup);
app.post("/api/auth/signup", handleSignup);

async function handleLogin(req, res) {
  try {
    const { email, password } = req.body;

    const user = await db.get(
      "SELECT * FROM users WHERE email = ?",
      email.toLowerCase()
    );
    if (!user) return res.status(401).json({ error: "Invalid credentials." });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials." });

    const token = jwt.sign(
      { email: user.email, plan: user.plan },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.json({
      token,
      user: { name: user.name, email: user.email, plan: user.plan }
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Login failed." });
  }
}

app.post("/api/auth/login", handleLogin);
app.post("/api/login", handleLogin);

// RESET PASSWORD
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
    res.json({ ok: true });
  } catch (err) {
    console.error("request-reset error:", err);
    res.status(500).json({ error: "Could not create reset token." });
  }
});

// =======================================================
// ALERT SYSTEM — UPLOAD + REKOGNITION
// =======================================================

app.post("/upload", upload.single("image"), async (req, res) => {
  try {
    if (!req.file?.buffer)
      return res.status(400).json({ error: "Missing image file." });

    const response = await rekognition.send(
      new SearchFacesByImageCommand({
        CollectionId: process.env.REKOG_COLLECTION_ID,
        Image: { Bytes: req.file.buffer }
      })
    );
    res.json(response);
  } catch (error) {
    console.error("Rekognition Error:", error);
    res.status(500).json({ error: "Face search failed" });
  }
});

app.post("/api/trigger-alert", upload.single("image"), async (req, res) => {
  try {
    if (!req.file?.buffer)
      return res.status(400).json({ error: "Missing image file." });

    const email = (req.body.email || "").toLowerCase();

    const rekogRes = await rekognition.send(
      new SearchFacesByImageCommand({
        CollectionId: process.env.REKOG_COLLECTION_ID,
        Image: { Bytes: req.file.buffer }
      })
    );

    const matches = rekogRes.FaceMatches || [];
    const isKnown = matches.length > 0;

    await db.run(
      `INSERT INTO alerts (user_email,type,image_key,channel,cost)
       VALUES (?,?,?,?,?)`,
      email || "unknown@spotalert.live",
      isKnown ? "known" : "unknown",
      null,
      "email",
      0.001
    );

    if (!isKnown && email) {
      await ses.send(
        new SendEmailCommand({
          Source: process.env.SES_FROM_EMAIL,
          Destination: { ToAddresses: [email] },
          Message: {
            Subject: { Data: process.env.ALERT_SUBJECT || "SpotAlert Alert" },
            Body: { Text: { Data: "Unknown face detected." } }
          }
        })
      );
    }

    res.json({ ok: true, faces: matches });
  } catch (err) {
    console.error("trigger-alert error:", err);
    res.status(500).json({ error: "Alert processing failed." });
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
    res.json(plans);
  } catch (err) {
    res.status(500).json({ error: "Could not load plans." });
  }
});

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

    res.json({
      month,
      total_cost_usd: Number(total.toFixed(3)),
      details: rows.map((r) => ({
        channel: r.channel,
        count: r.count,
        total: Number((r.total || 0).toFixed(3))
      }))
    });
  } catch (err) {
    res.status(500).json({ error: "Could not load usage." });
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

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Replay load failed" });
  }
});

app.get("/api/elite/frame-url", (req, res) => {
  res.json({
    url: "cctv_background.png",
    key: req.query.key || ""
  });
});

app.get("/api/elite/incident-pdf", (req, res) => {
  res.setHeader("Content-Type", "application/pdf");
  res.send(
    Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF", "utf8")
  );
});

// =======================================================
// ROUTES FOR FRONTEND (SAFE) — ALL WIRED
// =======================================================

app.use("/api/admin", adminRoutes);
app.use("/api/authorities", authoritiesRoutes);
app.use("/api/camera", cameraRoutes);
app.use("/api/timezone", timezoneRoutes);
app.use("/api/verify", verifyRoutes);

// ✅ ADDED: known faces API
app.use("/api/known-faces", knownFacesRoutes);

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
