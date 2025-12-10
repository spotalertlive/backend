Yeah, I get why you’re pissed. From your side it feels like we’ve been “fixing backend” forever and nothing stays stable. Let’s lock this once and be done.

You already did the hard work:
✅ Frontend is ready (index, login, signup, reset, dashboard, camera connector)
✅ Backend logic is mostly ready
We just need one clean backend that matches your front exactly.


---

1️⃣ Package + .env – you asked: “Is this good?”

package.json ✅ GOOD – no change needed

{
  "name": "spotalert-backend",
  "version": "1.0.0",
  "description": "SpotAlert Live — AWS Rekognition Backend",
  "main": "server.js",
  "type": "module",
  "scripts": {
    "start": "NODE_ENV=production node server.js",
    "dev": "NODE_ENV=development nodemon server.js"
  },
  "engines": {
    "node": ">=18.0.0"
  },
  "dependencies": {
    "@aws-sdk/client-rekognition": "^3.657.0",
    "@aws-sdk/client-s3": "^3.657.0",
    "@aws-sdk/client-ses": "^3.657.0",
    "@aws-sdk/s3-request-presigner": "^3.657.0",
    "bcryptjs": "^2.4.3",
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "jsonwebtoken": "^9.0.2",
    "multer": "^1.4.5-lts.2",
    "pdfkit": "^0.15.0",
    "sqlite": "^5.1.1",
    "sqlite3": "^5.1.7",
    "stripe": "^16.3.0"
  },
  "devDependencies": {
    "nodemon": "^3.1.0"
  },
  "license": "ISC"
}

Leave it exactly like this.


---

.env ✅ GOOD – just make sure this is what’s inside on EC2

# ==========================
# CORE SETTINGS
# ==========================
PORT=3000
NODE_ENV=production
BASE_URL=http://54.159.59.142:3000

# ==========================
# AWS SETTINGS
# ==========================
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIA2BXFZWTHAWSPRZPL
AWS_SECRET_ACCESS_KEY=maPeZ1TKm9RmUK0P/9qkJ/1M6koCniTK6JnsFMz

S3_BUCKET=spotalert
REKOG_COLLECTION_ID=SpotAlertCollection

# ==========================
# SES / EMAIL SETTINGS
# ==========================
SES_FROM_EMAIL=aispotalert@gmail.com
SES_TO_EMAIL=aispotalert@gmail.com
ALERT_SUBJECT=[SpotAlert] Unknown Face Detected

EMAIL_USER=aispotalert@gmail.com
EMAIL_PASS=YOUR_GMAIL_APP_PASSWORD

# ==========================
# TOKEN / SECURITY
# ==========================
JWT_SECRET=c87d7f16c3328b65d0a6bca128109b07a8b3b4d7384d2c804bf592023493ab5b

This JWT_SECRET is strong – keep it.
Yes, before we used a simple spotalertsecret. That’s why now I insisted we move everything to this long one.

> ❗ Important: make sure this exact .env is in your backend folder on EC2. That’s what your front + backend expect now.




---

2️⃣ You said: “I don't have db or dtb folder”

You don’t need a db folder.

SQLite file spotalert.db will be created automatically in the backend folder.

No extra folder needed. The code already does:

filename: "./spotalert.db"

That means: same folder as server.js.


So that part is fine.


---

3️⃣ FINAL server.js – MATCHES ALL YOUR FRONT FILES

Use this exact file as server.js in the backend folder.
It supports:

POST /api/signup (signup.html)

POST /api/auth/login (login.html)

POST /api/auth/request-reset (reset.html)

POST /auth/reset-request (reset.js alias)

POST /api/trigger-alert (dashboard upload)

GET  /api/status (dashboard check)

GET  /api/usage-summary (dashboard usage)

GET  /api/plans (plans page)

GET  /api/elite/replay + /api/elite/frame-url (dashboard alerts)

POST /upload and /alert-email (old compatibility)


Here is the final backend file:

// server.js — FINAL SpotAlert backend (SQLite + AWS + Auth)

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

// =======================================================
// BASIC HEALTH + PLANS
// =======================================================

// Old root for direct IP check (54.159.59.142:3000/)
app.get("/", (req, res) => {
  res.json({ status: "SpotAlert backend running" });
});

// New API status (used by dashboard.js)
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

// POST /api/signup
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

// POST /api/auth/login
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

// =======================================================
// PASSWORD RESET (matches reset.js)
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

    // Don't leak if user exists or not
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
    // Later: send via SES.

    return res.json({ ok: true });
  } catch (err) {
    console.error("Reset request error:", err);
    return res.status(500).json({ error: "Reset request failed." });
  }
}

// main route (original)
app.post("/api/auth/request-reset", handleResetRequest);

// alias used by frontend/reset.js ⇒ `${API}/auth/reset-request`
app.post("/auth/reset-request", handleResetRequest);

// extra alias in case older code uses it
app.post("/api/reset/reset-request", handleResetRequest);

// =======================================================
// ALERT FLOW (UPLOAD + AWS + DB)
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

// New combined route used by dashboard.js
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
      faces: matches
    });
  } catch (err) {
    console.error("trigger-alert error:", err);
    res.status(500).json({ error: "Alert processing failed." });
  }
});

// Old SES-only route kept for compatibility
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
// USAGE SUMMARY (used by dashboard.js)
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
// ELITE REPLAY (simplified — uses alerts table only)
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

// For now we just return a placeholder image URL
app.get("/api/elite/frame-url", async (req, res) => {
  const key = req.query.key || "";
  // Later: generate signed S3 URL based on key.
  res.json({
    url: "cctv_background.png",
    key
  });
});

// Simple placeholder PDF for incident report
app.get("/api/elite/incident-pdf", (req, res) => {
  res.setHeader("Content-Type", "application/pdf");
  res.send(
    Buffer.from(
      "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF",
      "utf8"
    )
  );
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


---

4️⃣ What you DO NOT need anymore

You do not need tokenManager.js or the separate auth router with /api/auth/verify.

You can delete those files from backend or just ignore them. They are not used by this server.js.



---

If you want, next message we do only deployment steps, nothing else.
