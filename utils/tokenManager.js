import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
dotenv.config();

// ============================================================
// SECURITY CHECK
// ============================================================
if (!process.env.JWT_SECRET) {
  console.error("❌ CRITICAL ERROR: Missing JWT_SECRET in environment variables.");
  process.exit(1);  // Stop the server to prevent insecure tokens
}

// ============================================================
// CREATE EMAIL VERIFICATION TOKEN (24 HOURS)
// ============================================================
export const createVerificationToken = (email) => {
  try {
    return jwt.sign(
      { email },
      process.env.JWT_SECRET,
      { expiresIn: "24h" }
    );
  } catch (err) {
    console.error("❌ Error creating verification token:", err.message);
    return null;
  }
};

// ============================================================
// VERIFY EMAIL TOKEN
// ============================================================
export const verifyToken = (token) => {
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    console.warn("⚠️ Verification failed:", err.message);
    return null;
  }
};
