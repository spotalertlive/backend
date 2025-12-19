import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST,
  port: process.env.MAIL_PORT,
  secure: false,
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS
  }
});

export async function sendContactEmail({ name, email, subject, message }) {
  return transporter.sendMail({
    from: `"SpotAlert Contact" <${process.env.MAIL_FROM}>`,
    to: process.env.SUPPORT_EMAIL,

    // 🔥 THIS MAKES REPLY WORK
    replyTo: email,

    subject: `[Contact] ${subject}`,
    text: `
Name: ${name}
Email: ${email}

Message:
${message}
    `
  });
}
