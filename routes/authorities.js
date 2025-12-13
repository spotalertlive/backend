import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
dotenv.config();

// Optional helpers (only used if files exist)
let sendEmail = () => {};
let createVerificationToken = () => null;
let verifyToken = () => null;

try {
  // ✅ LOWERCASE — Linux / EC2 SAFE
  sendEmail = (await import("../utils/sendemail.js")).sendEmail;
  ({ createVerificationToken, verifyToken } = await import("../utils/tokenmanager.js"));
} catch (e) {
  console.log("⚠️ Email verification modules not found — skipping verification features.");
}

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// OPTIONAL EMAIL VERIFICATION ROUTES (SAFE - WON'T BREAK LOGIN)
// ============================================================
router.post("/signup", async (req, res) => {
  if (!createVerificationToken || !sendEmail) {
    return res.json({
      success: true,
      message: "Signup OK (email verification disabled)"
    });
  }

  try {
    const { name, email } = req.body;

    const token = createVerificationToken(email);
    const verifyUrl = `${process.env.BASE_URL}/api/auth/verify?token=${token}`;

    await sendEmail(
      email,
      "Verify Your SpotAlert Email",
      path.join(__dirname, "../emails/verify.html"),
      { verify_url: verifyUrl, first_name: name }
    );

    res.json({
      success: true,
      message: "Verification email sent (optional)."
    });
  } catch (err) {
    return res.json({
      success: true,
      message: "Signup OK (email verification failed safely)"
    });
  }
});

// ============================================================
// OPTIONAL VERIFY ENDPOINT — DOES NOT IMPACT LOGIN
// ============================================================
router.get("/verify", (req, res) => {
  if (!verifyToken) {
    return res.send("Verification disabled.");
  }

  try {
    const decoded = verifyToken(req.query.token);
    if (!decoded) {
      return res.send("Invalid or expired verification link.");
    }

    return res.send("Email verified successfully.");
  } catch (err) {
    return res.send("Verification disabled.");
  }
});

export default router;
