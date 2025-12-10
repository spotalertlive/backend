// server.js — FINAL SpotAlert backend (SQLite + AWS + Auth + Admin + Tracking)

import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

import {
  RekognitionClient,
  SearchFacesByImageCommand
} from "@aws-sdk/client-rekognition";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

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

  // users + alerts + plans + visits
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

    CREATE TABLE IF NOT EXISTS visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT,
      ref TEXT,
      ip TEXT,
      user_agent TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // seed plans if empty
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
      99.99,
      20,
      30000
    );
  }

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
    return res.status(401).json({ error: "Invalid token" });
  }
}

// =======================================================
// BASIC HEALTH + PLANS
// =======================================================

// Old root for direct IP check (54.159.59.142:3000/)
app.get("/", (req, res) => {
  res.json({ status: "SpotAlert backend running" });
});

// New API status (used by dashboard.js / script.js)
app.get("/api/status", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Plans list (for plans.js)
app.get("/api/plans", async (req, res) => {
  try {
    const plans = await db.all(
      "SELECT id, name, price, cameras, scan_limit FROM plans ORDER BY price ASC"
    );
    res.json(plans);
  } catch (err) {
    console.error("plans error:", err);
    res.status(500).json({ error: "Could not load plans." });
  }
});

// =======================================================
// AUTH: SIGNUP + LOGIN
// =======================================================

// POST /api/signup  (signup.html / signup form)
app.post("/api/signup", async (req, res) => {
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

    res.json({
      token,
      user: {
        name,
        email: email.toLowerCase(),
        plan: "Free Trial"
      }
    });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ error: "Signup failed." });
  }
});

// POST /api/auth/login  (login.html / admin_login.html)
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "Email and password required." });

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
      user: {
        name: user.name,
        email: user.email,
        plan: user.plan
      }
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Login failed." });
  }
});

// Simple email verification placeholder (verify_email.js)
app.get("/api/auth/verify-email", (req, res) => {
  // For now just always "ok" so frontend shows success screen
  res.json({ ok: true, message: "Email verification completed." });
});

// =======================================================
// PASSWORD RESET (reset.html / reset.js)
// =======================================================

async function handleResetRequest(req, res) {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: "Email required." });
    }

    const user = await db.get(
      "SELECT * FROM users WHERE email = ?",
      email.toLowerCase()
    );

    // Do not leak if user exists
    if (!user) {
      return res.json({ ok: true });
    }

    const token = Math.random().toString(36).slice(2, 10);
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await db.run(
      "UPDATE users SET reset_token = ?, reset_expires = ? WHERE email = ?",
      token,
      expires.toISOString(),
      email.toLowerCase()
    );

    console.log("Password reset token for", email, "=", token);
    // Later: send via SES email.

    return res.json({ ok: true });
  } catch (err) {
    console.error("Reset request error:", err);
    return res.status(500).json({ error: "Reset request failed." });
  }
}

// main route (new)
app.post("/api/auth/request-reset", handleResetRequest);
// alias used by reset.js → `${API}/auth/reset-request`
app.post("/auth/reset-request", handleResetRequest);
// alias for any older code
app.post("/api/reset/reset-request", handleResetRequest);

// =======================================================
// CONTACT FORM (contact.html)
// =======================================================

app.post("/api/contact", async (req, res) => {
  try {
    const { name, email, message } = req.body;
    if (!name || !email || !message) {
      return res.status(400).json({ error: "All fields required." });
    }

    // Optional: send to your admin email via SES
    if (process.env.SES_FROM_EMAIL) {
      const params = {
        Source: process.env.SES_FROM_EMAIL,
        Destination: { ToAddresses: [process.env.SES_FROM_EMAIL] },
        Message: {
          Subject: { Data: `SpotAlert Contact from ${name}` },
          Body: {
            Text: {
              Data: `From: ${name} <${email}>\n\n${message}`
            }
          }
        }
      };
      await ses.send(new SendEmailCommand(params));
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("contact error:", err);
    res.status(500).json({ error: "Contact failed." });
  }
});

// =======================================================
// ALERT FLOW (camera_connector.js / dashboard alerts)
// =======================================================

// Old route kept for compatibility
app.post("/upload", upload.single("image"), async (req, res) => {
  try {
    const params = {
      CollectionId: process.env.REKOG_COLLECTION_ID,
      Image: { Bytes: req.file.buffer }
    };
    const response = await rekognition.send(
      new SearchFacesByImageCommand(params)
    );
    res.json(response);
  } catch (error) {
    console.error("Rekognition Error:", error);
    res.status(500).json({ error: "Face search failed" });
  }
});

// New combined route used by dashboard.js / camera_connector.js
app.post("/api/trigger-alert", upload.single("image"), async (req, res) => {
  try {
    const email = (req.body.email || "").toLowerCase();
    const plan = req.body.plan || "Free Trial";

    const params = {
      CollectionId: process.env.REKOG_COLLECTION_ID,
      Image: { Bytes: req.file.buffer }
    };

    const rekogRes = await rekognition.send(
      new SearchFacesByImageCommand(params)
    );

    const matches = rekogRes.FaceMatches || [];
    const isKnown = matches.length > 0;

    // record alert in DB
    await db.run(
      `INSERT INTO alerts (user_email, type, image_key, channel, cost)
       VALUES (?,?,?,?,?)`,
      email || "unknown@spotalert.live",
      isKnown ? "known" : "unknown",
      null,
      "email",
      0.001 // example cost per detection
    );

    // send email only for unknown
    if (!isKnown && email) {
      const body = `Unknown face detected for ${email} at ${new Date().toISOString()}`;
      const emailParams = {
        Source: process.env.SES_FROM_EMAIL,
        Destination: { ToAddresses: [email] },
        Message: {
          Subject: { Data: process.env.ALERT_SUBJECT || "SpotAlert Alert" },
          Body: { Text: { Data: body } }
        }
      };
      await ses.send(new SendEmailCommand(emailParams));
    }

    res.json({
      ok: true,
      faces: matches,
      plan
    });
  } catch (err) {
    console.error("trigger-alert error:", err);
    res.status(500).json({ error: "Alert processing failed." });
  }
});

// Old SES-only route kept for compatibility (alerts_email_system.js)
app.post("/alert-email", async (req, res) => {
  try {
    const { to, subject, message } = req.body;
    const emailParams = {
      Source: process.env.SES_FROM_EMAIL,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject },
        Body: { Text: { Data: message } }
      }
    };
    await ses.send(new SendEmailCommand(emailParams));
    res.json({ status: "Email sent" });
  } catch (error) {
    console.error("SES Error:", error);
    res.status(500).json({ error: "Email failed" });
  }
});

// =======================================================
// USAGE SUMMARY (dashboard.js)
// =======================================================

app.get("/api/usage-summary", async (req, res) => {
  try {
    const email = (req.query.email || "").toLowerCase();
    const month = new Date().toISOString().slice(0, 7); // YYYY-MM

    const rows = await db.all(
      `SELECT channel,
              COUNT(*) as count,
              SUM(cost) as total
       FROM alerts
       WHERE user_email = ?
         AND strftime('%Y-%m', timestamp) = ?
       GROUP BY channel`,
      email,
      month
    );

    const total = rows.reduce((sum, r) => sum + (r.total || 0), 0);

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
    console.error("usage-summary error:", err);
    res.status(500).json({ error: "Could not load usage." });
  }
});

// =======================================================
// ELITE REPLAY (dashboard.js, camera_history.html)
// =======================================================

app.get("/api/elite/replay", async (req, res) => {
  try {
    const minutes = parseInt(req.query.minutes || "10", 10);
    const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();

    const rows = await db.all(
      `SELECT id, type, image_key as image, timestamp
       FROM alerts
       WHERE timestamp >= ?
       ORDER BY timestamp DESC
       LIMIT 20`,
      since
    );

    res.json(rows);
  } catch (err) {
    console.error("elite/replay error:", err);
    res.status(500).json({ error: "Could not load replay data." });
  }
});

// For now we just return a placeholder image URL (cctv_background.png in frontend/public)
app.get("/api/elite/frame-url", async (req, res) => {
  const key = req.query.key || "";
  res.json({
    url: "cctv_background.png",
    key
  });
});

// Simple placeholder PDF for incident report
app.get("/api/elite/incident-pdf", (req, res) => {
  res.setHeader("Content-Type", "application/pdf");
  res.send(
    Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF", "utf8")
  );
});

// =======================================================
// VISITOR TRACKING (visitor_tracker.js)
// =======================================================

app.post("/api/track-visit", async (req, res) => {
  try {
    const { path, ref } = req.body || {};
    const ip =
      req.headers["x-forwarded-for"] ||
      req.connection.remoteAddress ||
      "unknown";
    const ua = req.headers["user-agent"] || "";

    await db.run(
      "INSERT INTO visits (path, ref, ip, user_agent) VALUES (?,?,?,?)",
      path || "",
      ref || "",
      String(ip),
      ua
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("track-visit error:", err);
    res.status(500).json({ error: "Could not track visit." });
  }
});

// =======================================================
// ADMIN PAGES (admin_dashboard, admin_users, admin_analytics)
// =======================================================

// List users (admin_users.js)
app.get("/api/admin/users", auth, async (req, res) => {
  try {
    const rows = await db.all(
      "SELECT id, name, email, plan, created_at FROM users ORDER BY created_at DESC"
    );
    res.json(rows);
  } catch (err) {
    console.error("admin users error:", err);
    res.status(500).json({ error: "Could not load users." });
  }
});

// Delete user (optional support from admin_users.js)
app.delete("/api/admin/users/:id", auth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await db.run("DELETE FROM users WHERE id = ?", id);
    res.json({ ok: true });
  } catch (err) {
    console.error("admin delete user error:", err);
    res.status(500).json({ error: "Could not delete user." });
  }
});

// Basic analytics (admin_analytics.js)
app.get("/api/admin/analytics", auth, async (req, res) => {
  try {
    const totalUsersRow = await db.get(
      "SELECT COUNT(*) as count FROM users"
    );
    const totalAlertsRow = await db.get(
      "SELECT COUNT(*) as count FROM alerts"
    );
    const unknownAlertsRow = await db.get(
      "SELECT COUNT(*) as count FROM alerts WHERE type = 'unknown'"
    );

    res.json({
      total_users: totalUsersRow.count || 0,
      total_alerts: totalAlertsRow.count || 0,
      unknown_alerts: unknownAlertsRow.count || 0
    });
  } catch (err) {
    console.error("admin analytics error:", err);
    res.status(500).json({ error: "Could not load analytics." });
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
    });
  })
  .catch((err) => {
    console.error("Failed to init DB:", err);
    process.exit(1);
  });
