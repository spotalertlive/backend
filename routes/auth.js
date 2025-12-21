import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { SendEmailCommand } from "@aws-sdk/client-ses";

const router = express.Router();

/* =========================
   HELPERS
========================= */
function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "30d" });
}

/* =========================
   SIGNUP
========================= */
router.post("/signup", async (req, res) => {
  const db = req.app.get("db");
  const ses = req.app.get("ses");

  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: "All fields required" });

  const exists = await db.get(
    "SELECT id FROM users WHERE email=?",
    email.toLowerCase()
  );
  if (exists) return res.status(409).json({ error: "Email already exists" });

  const hash = await bcrypt.hash(password, 10);
  const token = crypto.randomBytes(20).toString("hex");

  await db.run(
    `INSERT INTO users (name,email,password_hash,plan,reset_token)
     VALUES (?,?,?,?,?)`,
    name,
    email.toLowerCase(),
    hash,
    "Free Trial",
    token
  );

  // verification email
  await ses.send(
    new SendEmailCommand({
      Source: process.env.SES_FROM_EMAIL,
      Destination: { ToAddresses: [email] },
      Message: {
        Subject: { Data: "Verify your SpotAlert account" },
        Body: {
          Text: {
            Data: `Verify your account:\nhttps://spotalert.live/verify.html?token=${token}`
          }
        }
      }
    })
  );

  res.json({ ok: true });
});

/* =========================
   VERIFY EMAIL
========================= */
router.post("/verify", async (req, res) => {
  const db = req.app.get("db");
  const { token } = req.body;

  const user = await db.get(
    "SELECT id FROM users WHERE reset_token=?",
    token
  );
  if (!user) return res.status(400).json({ error: "Invalid token" });

  await db.run(
    "UPDATE users SET reset_token=NULL WHERE id=?",
    user.id
  );

  res.json({ ok: true });
});

/* =========================
   LOGIN
========================= */
router.post("/login", async (req, res) => {
  const db = req.app.get("db");
  const { email, password } = req.body;

  const user = await db.get(
    "SELECT * FROM users WHERE email=?",
    email.toLowerCase()
  );
  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  if (user.reset_token)
    return res.status(403).json({ error: "Email not verified" });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });

  const token = signToken({ email: user.email, plan: user.plan });

  res.json({
    token,
    user: { name: user.name, email: user.email, plan: user.plan }
  });
});

/* =========================
   REQUEST PASSWORD RESET
========================= */
router.post("/request-reset", async (req, res) => {
  const db = req.app.get("db");
  const ses = req.app.get("ses");

  const email = (req.body.email || "").toLowerCase();
  const user = await db.get("SELECT id FROM users WHERE email=?", email);
  if (!user) return res.json({ ok: true });

  const token = crypto.randomBytes(20).toString("hex");

  await db.run(
    "UPDATE users SET reset_token=? WHERE id=?",
    token,
    user.id
  );

  await ses.send(
    new SendEmailCommand({
      Source: process.env.SES_FROM_EMAIL,
      Destination: { ToAddresses: [email] },
      Message: {
        Subject: { Data: "Reset your SpotAlert password" },
        Body: {
          Text: {
            Data: `Reset password:\nhttps://spotalert.live/reset.html?token=${token}`
          }
        }
      }
    })
  );

  res.json({ ok: true });
});

/* =========================
   RESET PASSWORD
========================= */
router.post("/reset", async (req, res) => {
  const db = req.app.get("db");
  const { token, password } = req.body;

  const user = await db.get(
    "SELECT id FROM users WHERE reset_token=?",
    token
  );
  if (!user) return res.status(400).json({ error: "Invalid token" });

  const hash = await bcrypt.hash(password, 10);

  await db.run(
    "UPDATE users SET password_hash=?, reset_token=NULL WHERE id=?",
    hash,
    user.id
  );

  res.json({ ok: true });
});

export default router;
