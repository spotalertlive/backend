import jwt from "jsonwebtoken";
import dotenv from "dotenv";
dotenv.config();

/**
 * DO NOT crash backend.
 * If JWT_SECRET is missing, we fallback safely.
 */
const JWT_SECRET =
  process.env.JWT_SECRET || "TEMP_DEV_FALLBACK_SECRET_CHANGE_ME";

/* ==============================
   CREATE EMAIL VERIFICATION TOKEN
   VALID 24 HOURS
================================ */
export const createVerificationToken = (email) => {
  if (!email) return null;

  try {
    return jwt.sign(
      { email },
      JWT_SECRET,
      { expiresIn: "24h" }
    );
  } catch (err) {
    console.error("❌ Token create failed:", err.message);
    return null;
  }
};

/* ==============================
   VERIFY EMAIL TOKEN
================================ */
export const verifyToken = (token) => {
  if (!token) return null;

  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
};
