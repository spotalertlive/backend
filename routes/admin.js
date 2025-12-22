import express from "express";
import jwt from "jsonwebtoken";

const router = express.Router();

/* =========================
   ADMIN LOGIN
   POST /api/admin/login
========================= */
router.post("/login", (req, res) => {
  const { username, password } = req.body || {};

  if (
    username === process.env.ADMIN_USER &&
    password === process.env.ADMIN_PASS
  ) {
    if (!process.env.ADMIN_JWT_SECRET) {
      return res.status(500).json({ error: "ADMIN_JWT_SECRET missing" });
    }

    const token = jwt.sign(
      { role: "admin" },
      process.env.ADMIN_JWT_SECRET,
      { expiresIn: "2h" } // 🔒 shorter life
    );

    return res.json({ ok: true, token });
  }

  return res.status(401).json({ error: "Invalid admin credentials" });
});

/* =========================
   ADMIN AUTH MIDDLEWARE
========================= */
function adminAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing admin token" });
  }

  try {
    const decoded = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
    if (decoded.role !== "admin") {
      return res.status(403).json({ error: "Not admin" });
    }
    next();
  } catch {
    return res.status(401).json({ error: "Invalid admin token" });
  }
}

/* =========================
   LIST USERS
   GET /api/admin/users
========================= */
router.get("/users", adminAuth, async (req, res) => {
  try {
    const db = req.app.get("db");
    if (!db) return res.status(500).json({ error: "DB not ready" });

    const users = await db.all(
      `SELECT id, name, email, plan, created_at
       FROM users
       ORDER BY created_at DESC`
    );

    res.json({ users });
  } catch (err) {
    console.error("admin users error:", err);
    res.status(500).json({ error: "Failed to load users" });
  }
});

/* =========================
   ANALYTICS
   GET /api/admin/analytics
========================= */
router.get("/analytics", adminAuth, async (req, res) => {
  try {
    const db = req.app.get("db");

    const totalUsers = await db.get(
      "SELECT COUNT(*) as cnt FROM users"
    );
    const totalAlerts = await db.get(
      "SELECT COUNT(*) as cnt FROM alerts"
    );
    const revenue = await db.get(
      "SELECT SUM(cost) as total FROM alerts"
    );

    res.json({
      total_users: totalUsers.cnt || 0,
      total_alerts: totalAlerts.cnt || 0,
      revenue_usd: Number((revenue.total || 0).toFixed(2))
    });
  } catch (err) {
    console.error("admin analytics error:", err);
    res.status(500).json({ error: "Analytics failed" });
  }
});

/* =========================
   DISABLE USER
   POST /api/admin/user/disable
========================= */
router.post("/user/disable", adminAuth, async (req, res) => {
  try {
    const db = req.app.get("db");
    const email = (req.body.email || "").toLowerCase();

    if (!email) {
      return res.status(400).json({ error: "Email required" });
    }

    await db.run(
      "UPDATE users SET plan='disabled' WHERE email=?",
      email
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("disable user error:", err);
    res.status(500).json({ error: "Disable failed" });
  }
});

/* =========================
   ENABLE USER
   POST /api/admin/user/enable
========================= */
router.post("/user/enable", adminAuth, async (req, res) => {
  try {
    const db = req.app.get("db");
    const email = (req.body.email || "").toLowerCase();
    const plan = req.body.plan || "Free Trial";

    if (!email) {
      return res.status(400).json({ error: "Email required" });
    }

    await db.run(
      "UPDATE users SET plan=? WHERE email=?",
      plan,
      email
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("enable user error:", err);
    res.status(500).json({ error: "Enable failed" });
  }
});

export default router;
