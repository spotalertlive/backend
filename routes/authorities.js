import express from "express";
import jwt from "jsonwebtoken";

const router = express.Router();

/* =========================
   AUTH MIDDLEWARE
========================= */
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing token" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { email, plan }
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

/* =========================
   REPORT TO AUTHORITIES
   POST /api/authorities/report
========================= */
router.post("/report", requireAuth, async (req, res) => {
  try {
    const db = req.app.get("db");
    if (!db) return res.status(500).json({ error: "DB not ready" });

    const email = (req.user.email || "").toLowerCase();
    const payload = req.body || {};

    await db.run(
      `INSERT INTO event_logs (user_email, type, payload)
       VALUES (?, ?, ?)`,
      email,
      "authorities_report",
      JSON.stringify({
        ...payload,
        reported_at: new Date().toISOString()
      })
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("Authorities report error:", err);
    return res.status(500).json({ error: "Failed to submit report" });
  }
});

/* =========================
   LIST AUTHORITY REPORTS
   (USER ONLY)
========================= */
router.get("/reports", requireAuth, async (req, res) => {
  try {
    const db = req.app.get("db");
    const email = (req.user.email || "").toLowerCase();

    const rows = await db.all(
      `SELECT id, payload, created_at
       FROM event_logs
       WHERE user_email=? AND type='authorities_report'
       ORDER BY created_at DESC
       LIMIT 100`,
      email
    );

    return res.json(rows.map(r => ({
      id: r.id,
      data: JSON.parse(r.payload || "{}"),
      created_at: r.created_at
    })));
  } catch (err) {
    console.error("Authorities list error:", err);
    return res.status(500).json({ error: "Failed to load reports" });
  }
});

export default router;
