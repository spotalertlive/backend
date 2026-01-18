import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";

const router = express.Router();

/* =========================
   HELPERS
========================= */
function normalizeEmail(email) {
  return (email || "").toLowerCase().trim();
}

function signToken(user) {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET missing");
  }

  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      plan: user.plan
    },
    process.env.JWT_SECRET,
    { expiresIn: "30d" }
  );
}

/* =========================
   SIGNUP
========================= */
router.post("/signup", async (req, res) => {
  try {
    const db = req.app.get("db");

    const name = (req.body.name || "").trim();
    const email = normalizeEmail(req.body.email);
    const password = req.body.password || "";

    if (!name || !email || !password) {
      return res.status(400).json({ error: "All fields required" });
    }

    const existing = await db.get(
      "SELECT id FROM users WHERE email = ?",
      email
    );

    if (existing) {
      return res.status(409).json({ error: "Email already exists" });
    }

    const hash = await bcrypt.hash(password, 10);
    const verifyToken = crypto.randomBytes(32).toString("hex");

    await db.run(
      `INSERT INTO users
       (name, email, password_hash, plan, email_verified, verify_token)
       VALUES (?, ?, ?, ?, ?, ?)`,
      name,
      email,
      hash,
      "Free Trial",
      0,
      verifyToken
    );

    // Email sending handled elsewhere or later (locked backend)
    return res.json({ ok: true });
  } catch (err) {
    console.error("Signup error:", err);
    return res.status(500).json({ error: "Signup failed" });
  }
});

/* =========================
   VERIFY EMAIL
========================= */
router.post("/verify", async (req, res) => {
  try {
    const db = req.app.get("db");
    const token = req.body.token;

    if (!token) {
      return res.status(400).json({ error: "Missing token" });
    }

    const user = await db.get(
      "SELECT id FROM users WHERE verify_token = ?",
      token
    );

    if (!user) {
      return res.status(400).json({ error: "Invalid token" });
    }

    await db.run(
      "UPDATE users SET email_verified = 1, verify_token = NULL WHERE id = ?",
      user.id
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("Verify error:", err);
    return res.status(500).json({ error: "Verification failed" });
  }
});

/* =========================
   LOGIN
========================= */
router.post("/login", async (req, res) => {
  try {
    const db = req.app.get("db");

    const email = normalizeEmail(req.body.email);
    const password = req.body.password || "";

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    const user = await db.get(
      "SELECT * FROM users WHERE email = ?",
      email
    );

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

    const token = signToken(user);

    return res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        plan: user.plan
      }
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Login failed" });
  }
});

/* =========================
   REQUEST PASSWORD RESET
========================= */
router.post("/request-reset", async (req, res) => {
  try {
    const db = req.app.get("db");
    const email = normalizeEmail(req.body.email);

    if (!email) {
      return res.json({ ok: true });
    }

    const user = await db.get(
      "SELECT id FROM users WHERE email = ?",
      email
    );

    if (!user) {
      return res.json({ ok: true });
    }

    const token = crypto.randomBytes(32).toString("hex");

    await db.run(
      "UPDATE users SET reset_token = ? WHERE id = ?",
      token,
      user.id
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("Request reset error:", err);
    return res.status(500).json({ error: "Request reset failed" });
  }
});

/* =========================
   RESET PASSWORD
========================= */
router.post("/reset", async (req, res) => {
  try {
    const db = req.app.get("db");

    const token = req.body.token;
    const password = req.body.password || "";

    if (!token || !password) {
      return res.status(400).json({ error: "Missing token or password" });
    }

    const user = await db.get(
      "SELECT id FROM users WHERE reset_token = ?",
      token
    );

    if (!user) {
      return res.status(400).json({ error: "Invalid token" });
    }

    const hash = await bcrypt.hash(password, 10);

    await db.run(
      "UPDATE users SET password_hash = ?, reset_token = NULL WHERE id = ?",
      hash,
      user.id
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("Reset error:", err);
    return res.status(500).json({ error: "Reset failed" });
  }
});

export default router;
