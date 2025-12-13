import express from "express";
import jwt from "jsonwebtoken";

const router = express.Router();

/**
 * POST /api/admin/login
 */
router.post("/login", (req, res) => {
  const { username, password } = req.body;

  if (
    username === process.env.ADMIN_USER &&
    password === process.env.ADMIN_PASS
  ) {
    const token = jwt.sign(
      { role: "admin" },
      process.env.JWT_SECRET,
      { expiresIn: "12h" }
    );

    return res.json({ ok: true, token });
  }

  return res.status(401).json({ error: "Invalid admin credentials" });
});

/**
 * Admin auth middleware
 */
function adminAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) return res.status(401).json({ error: "Missing admin token" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== "admin") throw new Error("Not admin");
    next();
  } catch {
    return res.status(401).json({ error: "Invalid admin token" });
  }
}

/**
 * GET /api/admin/users
 */
router.get("/users", adminAuth, async (req, res) => {
  res.json({ users: [], msg: "SQLite integration pending" });
});

/**
 * GET /api/admin/analytics
 */
router.get("/analytics", adminAuth, (req, res) => {
  res.json({
    total_alerts: 0,
    total_users: 0,
    revenue: 0
  });
});

/**
 * POST /api/admin/user/disable
 */
router.post("/user/disable", adminAuth, (req, res) => {
  res.json({ ok: true });
});

/**
 * POST /api/admin/user/enable
 */
router.post("/user/enable", adminAuth, (req, res) => {
  res.json({ ok: true });
});

export default router;
