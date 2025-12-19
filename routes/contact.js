import express from "express";
import sendEmail from "../utils/sendemail.js";

const router = express.Router();

/**
 * POST /api/contact
 * Receives contact form and sends email
 */
router.post("/", async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;

    if (!name || !email || !subject || !message) {
      return res.status(400).json({ error: "Missing fields" });
    }

    // 👇 IMPORTANT: reply-to is the user's email
    await sendEmail({
      to: process.env.SUPPORT_EMAIL,
      subject: `[SpotAlert Contact] ${subject}`,
      replyTo: email,
      text: `
New Contact Message

Name: ${name}
Email: ${email}
Subject: ${subject}

Message:
${message}
      `
    });

    res.json({ ok: true });

  } catch (err) {
    console.error("Contact error:", err);
    res.status(500).json({ error: "Failed to send message" });
  }
});

export default router;
