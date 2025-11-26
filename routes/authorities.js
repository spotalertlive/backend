import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
dotenv.config();

// ✅ Correct, case-sensitive imports for Linux/EC2
import { sendEmail } from "../utils/sendemail.js";            // utils/sendemail.js
import { createVerificationToken, verifyToken } from "../utils/tokenManager.js"; // utils/tokenManager.js

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// BACKEND BASE URL (used in email verification link)
// ============================================================
// 1) Prefer BASE_URL from .env (no trailing slash)
// 2) Otherwise, use api.spotalert.live in production
// 3) Fallback to localhost in dev
const envBase = process.env.BASE_URL ? process.env.BASE_URL.trim().replace(/\/+$/, "") : "";
const BACKEND_BASE =
  envBase ||
  (process.env.NODE_ENV === "production"
    ? "https://api.spotalert.live"
    : "http://localhost:3000");

console.log("🌐 Using BACKEND_BASE for auth emails:", BACKEND_BASE);

// ============================================================
// SIGNUP
// ============================================================
router.post("/signup", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: "All fields are required." });
    }

    // 🔐 Create email verification token
    const token = createVerificationToken(email);
    if (!token) {
      console.error("❌ Failed to create verification token");
      return res.status(500).json({ error: "Failed to create verification token." });
    }

    // Build verification URL used in email
    const verifyUrl = `${BACKEND_BASE}/api/auth/verify?token=${encodeURIComponent(token)}`;
    console.log("🔗 Verification URL:", verifyUrl);

    // 📧 Send verification email
    await sendEmail(
      email,
      "Welcome to SpotAlert – Verify Your Account",
      path.join(__dirname, "../emails/verify.html"),
      {
        verify_url: verifyUrl,
        first_name: name || "User",
      }
    );

    console.log(`✅ Signup email sent to: ${email}`);

    // NOTE:
    // Actual user creation (DB insert, password hash, etc.)
    // should be handled in your token manager / controller logic.
    // This route focuses on email verification flow.

    return res.json({
      success: true,
      message: "Account created! Check your email to verify.",
    });
  } catch (err) {
    console.error("❌ /signup error:", err);
    return res.status(500).json({ error: "Signup failed. Please try again." });
  }
});

// ============================================================
// VERIFY EMAIL
// ============================================================
router.get("/verify", (req, res) => {
  try {
    const token = req.query.token;

    if (!token) {
      console.warn("⚠️ Missing verification token");
      return res.sendFile(path.join(__dirname, "../emails/verify-expired.html"));
    }

    const decoded = verifyToken(token);

    if (!decoded || !decoded.email) {
      console.warn("⚠️ Invalid or expired verification token");
      return res.sendFile(path.join(__dirname, "../emails/verify-expired.html"));
    }

    console.log(`✅ Email verified: ${decoded.email}`);

    // 👉 If you want to mark user as verified in DB,
    // you can do it here using decoded.email.

    return res.sendFile(path.join(__dirname, "../emails/verified-success.html"));
  } catch (err) {
    console.error("❌ /verify error:", err);
    return res.sendFile(path.join(__dirname, "../emails/verify-expired.html"));
  }
});

// ============================================================
// RESEND VERIFICATION
// ============================================================
router.post("/resend", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email is required." });
    }

    const token = createVerificationToken(email);
    if (!token) {
      console.error("❌ Failed to create token for resend");
      return res.status(500).json({ error: "Failed to create verification token." });
    }

    const verifyUrl = `${BACKEND_BASE}/api/auth/verify?token=${encodeURIComponent(token)}`;

    await sendEmail(
      email,
      "Verify your SpotAlert account",
      path.join(__dirname, "../emails/verify.html"),
      {
        verify_url: verifyUrl,
        first_name: "User",
      }
    );

    console.log(`📨 Resent verification to: ${email}`);

    return res.json({
      success: true,
      message: "Verification email sent.",
    });
  } catch (err) {
    console.error("❌ /resend error:", err);
    return res.status(500).json({ error: "Failed to resend verification email." });
  }
});

export default router;
