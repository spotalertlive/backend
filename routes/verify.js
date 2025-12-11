import express from "express";
import { createVerificationToken, verifyToken } from "../utils/tokenManager.js";
import { sendEmail } from "../utils/sendemail.js";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// POST /api/auth/resend
router.post("/auth/resend", async (req, res) => {
  const { email } = req.body;

  const token = createVerificationToken(email);
  const verifyUrl = `https://api.spotalert.live/api/auth/verify?token=${token}`;

  await sendEmail(
    email,
    "Verify Your Account",
    path.join(__dirname, "../emails/verify.html"),
    { verify_url: verifyUrl }
  );

  res.json({ ok: true });
});

// GET /api/auth/verify
router.get("/auth/verify", (req, res) => {
  try {
    const token = req.query.token;
    const decoded = verifyToken(token);

    if (!decoded || !decoded.email) {
      return res.sendFile(path.join(__dirname, "../emails/verify-expired.html"));
    }

    return res.sendFile(path.join(__dirname, "../emails/verified-success.html"));
  } catch {
    return res.sendFile(path.join(__dirname, "../emails/verify-expired.html"));
  }
});

export default router;
