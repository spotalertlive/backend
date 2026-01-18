import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import sqlite3 from "sqlite3";
import nodemailer from "nodemailer";

const router = express.Router();

/* =========================
   DATABASE
========================= */
const db = new sqlite3.Database(
  "/home/ubuntu/spotalert-backend/database.db"
);

/* =========================
   ENV
========================= */
const {
  JWT_SECRET,
  APP_URL,
  MAIL_HOST,
  MAIL_PORT,
  MAIL_USER,
  MAIL_PASS,
  FROM_EMAIL
} = process.env;

if (!JWT_SECRET || !APP_URL) {
  console.error("❌ Missing required env vars");
}

/* =========================
   MAILER
========================= */
const transporter = nodemailer.createTransport({
  host: MAIL_HOST,
  port: Number(MAIL_PORT),
  secure: Number(MAIL_PORT) === 465,
  auth: {
    user: MAIL_USER,
    pass: MAIL_PASS
  }
});

/* =========================
   HELPERS
========================= */
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "30d" });
}

function normalizeEmail(email) {
  return (email || "").toLowerCase().trim();
}

/* =========================
   SIGN UP
========================= */
router.post("/signup", async (req, res) => {
  const name = (req.body.name || "").trim();
  const email = normalizeEmail(req.body.email);
  const password = req.body.password || "";

  if (!name || !email || !password) {
    return res.status(400).json({ error: "All fields required" });
  }

  db.get(
    "SELECT id FROM users WHERE email=?",
    [email],
    async (err, user) => {
      if (user) {
        return res.status(409).json({ error: "Email already exists" });
      }

      const hash = await bcrypt.hash(password, 10);
      const verifyToken = crypto.randomBytes(32).toString("hex");

      db.run(
        `INSERT INTO users
         (name,email,password_hash,verify_token,email_verified)
         VALUES (?,?,?,?,0)`,
        [name, email, hash, verifyToken],
        async () => {
          const link = `${APP_URL}/verify.html?token=${verifyToken}`;

          try {
            await transporter.sendMail({
              from: FROM_EMAIL,
              to: email,
              subject: "Verify your SpotAlert account",
              html: `
                <p>Welcome to SpotAlert</p>
                <p>Verify your email:</p>
                <a href="${link}">${link}</a>
              `
            });
          } catch (e) {
            console.error("Mail error:", e);
          }

          res.json({ ok: true });
        }
      );
    }
  );
});

/* =========================
   VERIFY EMAIL
========================= */
router.post("/verify", (req, res) => {
  const token = req.body.token;

  if (!token) {
    return res.status(400).json({ error: "Missing token" });
  }

  db.get(
    "SELECT id FROM users WHERE verify_token=?",
    [token],
    (err, user) => {
      if (!user) {
        return res.status(400).json({ error: "Invalid token" });
      }

      db.run(
        "UPDATE users SET verify_token=NULL, email_verified=1 WHERE id=?",
        [user.id],
        () => res.json({ ok: true })
      );
    }
  );
});

/* =========================
   LOGIN
========================= */
router.post("/login", async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = req.body.password || "";

  db.get(
    "SELECT * FROM users WHERE email=?",
    [email],
    async (err, user) => {
      if (!user) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      if (!user.email_verified) {
        return res.status(403).json({ error: "Email not verified" });
      }

      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const token = signToken({
        id: user.id,
        email: user.email
      });

      res.json({
        token,
        user: {
          name: user.name,
          email: user.email
        }
      });
    }
  );
});

/* =========================
   REQUEST RESET
========================= */
router.post("/request-reset", (req, res) => {
  const email = normalizeEmail(req.body.email);
  const token = crypto.randomBytes(32).toString("hex");

  db.run(
    "UPDATE users SET reset_token=? WHERE email=?",
    [token, email],
    async () => {
      const link = `${APP_URL}/reset.html?token=${token}`;

      try {
        await transporter.sendMail({
          from: FROM_EMAIL,
          to: email,
          subject: "Reset your SpotAlert password",
          html: `<a href="${link}">${link}</a>`
        });
      } catch {}

      res.json({ ok: true });
    }
  );
});

/* =========================
   RESET PASSWORD
========================= */
router.post("/reset", async (req, res) => {
  const token = req.body.token;
  const password = req.body.password || "";

  const hash = await bcrypt.hash(password, 10);

  db.run(
    "UPDATE users SET password_hash=?, reset_token=NULL WHERE reset_token=?",
    [hash, token],
    function () {
      if (this.changes === 0) {
        return res.status(400).json({ error: "Invalid token" });
      }
      res.json({ ok: true });
    }
  );
});

export default router;
