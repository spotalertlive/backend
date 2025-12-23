// backend/middleware/adminRateLimit.js
// Simple in-memory rate limit for admin routes
// Protects admin login & admin APIs from brute force

const adminHits = new Map();

/*
  limit: max requests
  windowMs: time window in ms
*/
export function adminRateLimit({ limit = 20, windowMs = 15 * 60 * 1000 } = {}) {
  return (req, res, next) => {
    const ip =
      req.headers["x-forwarded-for"] ||
      req.socket.remoteAddress ||
      "unknown";

    const now = Date.now();
    const record = adminHits.get(ip) || { count: 0, start: now };

    // reset window
    if (now - record.start > windowMs) {
      record.count = 0;
      record.start = now;
    }

    record.count += 1;
    adminHits.set(ip, record);

    if (record.count > limit) {
      return res.status(429).json({
        error: "Too many admin requests. Try again later."
      });
    }

    next();
  };
}
