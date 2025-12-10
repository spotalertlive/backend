import fs from "fs";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
dotenv.config();

export const sendEmail = async (
  to,
  subject,
  templatePath,
  replacements = {}
) => {
  try {
    let html = fs.readFileSync(templatePath, "utf-8");

    // Replace placeholders like {{reset_url}} and {{first_name}}
    for (const [key, value] of Object.entries(replacements)) {
      html = html.replace(new RegExp(`{{${key}}}`, "g"), value);
    }

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true, // SSL
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS // MUST be Gmail App Password
      }
    });

    await transporter.sendMail({
      from: `"SpotAlert" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html
    });

    console.log(`✅ Email sent to ${to}`);
  } catch (err) {
    console.error("❌ Email sending error:", err);
    throw new Error("Email sending failed.");
  }
};
