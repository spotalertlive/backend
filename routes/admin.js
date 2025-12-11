import express from "express";
const router = express.Router();

let adminLoggedIn = false;

// POST /api/admin/login
router.post("/admin/login", (req, res) => {
  const { username, password } = req.body;

  if (username === "admin" && password === "admin123") {
    adminLoggedIn = true;
    return res.json({ ok: true });
  }

  return res.status(401).json({ error: "Invalid admin credentials" });
});

// GET /api/admin/users
router.get("/admin/users", async (req, res) => {
  // TODO: load from SQLite when needed
  res.json({ users: [], msg: "SQLite integration pending" });
});

// GET /api/admin/analytics
router.get("/admin/analytics", (req, res) => {
  res.json({
    total_alerts: 0,
    total_users: 0,
    revenue: 0,
  });
});

// POST /api/admin/user/disable
router.post("/admin/user/disable", (req, res) => {
  res.json({ ok: true });
});

// POST /api/admin/user/enable
router.post("/admin/user/enable", (req, res) => {
  res.json({ ok: true });
});

export default router;
