// backend/utils/tokenmanager.js
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
dotenv.config();

// ============================================================
// SAFE SECRET RESOLUTION (NO CRASH)
// ============================================================
function getJwtSecret() {
  if (!process.env.JWT_SECRET) {
    console.warn(
      "⚠️ JWT_SECRET missing — token features disabled but server continues"
    );
    return null;
  }
  return process.env.JWT_SECRET;
}

// ============================================================
// CREATE EMAIL VERIFICATION TOKEN (24h)
// ============================================================
export const createVerificationToken = (email) => {
  const secret = getJwtSecret();
  if (!secret || !email) return null;

  try {
    return jwt.sign(
      { email },
      secret,
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
  const secret = getJwtSecret();
  if (!secret || !token) return null;

  try {
    return jwt.verify(token, secret);
  } catch (err) {
    console.warn("⚠️ Verification failed:", err.message);
    return null;
  }
};
