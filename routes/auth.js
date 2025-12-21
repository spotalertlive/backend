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
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET missing");
  }
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "30d" });
}

/* =========================
   SIGNUP
========================= */
router.post("/signup", async (req, res) => {
  try {
    const db = req.app.get("db");
    const ses = req.app.get("ses");

    const name = (req.body.name || "").trim();
    const email = (req.body.email || "").toLowerCase().trim();
    const password = req.body.password || "";

    if (!name || !email || !password) {
      return res.status(400).json({ error: "All fields required" });
    }

    const exists = await db.get(
      "SELECT id FROM users WHERE email=?",
      email
    );
    if (exists) {
      return res.status(409).json({ error: "Email already exists" });
    }

    const hash = await bcrypt.hash(password, 10);
    const token = crypto.randomBytes(20).toString("hex");

    await db.run(
      `INSERT INTO users (name,email,password_hash,plan,reset_token)
       VALUES (?,?,?,?,?)`,
      name,
      email,
      hash,
      "Free Trial",
      token
    );

    // ✅ Email verification (SAFE — will not crash backend)
    if (ses && process.env.SES_FROM_EMAIL) {
      try {
        await ses.send(
          new SendEmailCommand({
            Source: process.env.SES_FROM_EMAIL,
            Destination: { ToAddresses: [email] },
            Message: {
              Subject: { Data: "Verify your SpotAlert account" },
              Body: {
                Text: {
                  Data:
`Verify your SpotAlert account:

https://spotalert.live/verify.html?token=${token}

If you did not create this account, ignore this email.`
                }
              }
            }
          })
        );
      } catch (e) {
        console.error("SES verification email failed:", e);
      }
    }

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
      "SELECT id FROM users WHERE reset_token=?",
      token
    );
    if (!user) {
      return res.status(400).json({ error: "Invalid token" });
    }

    await db.run(
      "UPDATE users SET reset_token=NULL WHERE id=?",
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
    const email = (req.body.email || "").toLowerCase().trim();
    const password = req.body.password || "";

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    const user = await db.get(
      "SELECT * FROM users WHERE email=?",
      email
    );
    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    if (user.reset_token) {
      return res.status(403).json({ error: "Email not verified" });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = signToken({
      email: user.email,
      plan: user.plan
    });

    return res.json({
      token,
      user: {
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
    const ses = req.app.get("ses");

    const email = (req.body.email || "").toLowerCase().trim();
    if (!email) return res.json({ ok: true });

    const user = await db.get(
      "SELECT id FROM users WHERE email=?",
      email
    );
    if (!user) return res.json({ ok: true });

    const token = crypto.randomBytes(20).toString("hex");

    await db.run(
      "UPDATE users SET reset_token=? WHERE id=?",
      token,
      user.id
    );

    if (ses && process.env.SES_FROM_EMAIL) {
      try {
        await ses.send(
          new SendEmailCommand({
            Source: process.env.SES_FROM_EMAIL,
            Destination: { ToAddresses: [email] },
            Message: {
              Subject: { Data: "Reset your SpotAlert password" },
              Body: {
                Text: {
                  Data:
`Reset your SpotAlert password:

https://spotalert.live/reset.html?token=${token}

If you did not request this, ignore this email.`
                }
              }
            }
          })
        );
      } catch (e) {
        console.error("SES reset email failed:", e);
      }
    }

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
      "SELECT id FROM users WHERE reset_token=?",
      token
    );
    if (!user) {
      return res.status(400).json({ error: "Invalid token" });
    }

    const hash = await bcrypt.hash(password, 10);

    await db.run(
      "UPDATE users SET password_hash=?, reset_token=NULL WHERE id=?",
      hash,
      user.id
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("Reset password error:", err);
    return res.status(500).json({ error: "Reset failed" });
  }
});

export default router;
