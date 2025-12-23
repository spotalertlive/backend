// backend/routes/cost.js
import express from "express";
import jwt from "jsonwebtoken";

const router = express.Router();

/*
  COST + USAGE SUMMARY
  - Per user
  - Per location (house / cottage / plant)
  - Per month
*/

/* =========================
   JWT AUTH MIDDLEWARE (REQUIRED)
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
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

/* =========================
   MONTHLY SUMMARY
   GET /api/cost/summary
========================= */
router.get("/summary", requireAuth, async (req, res) => {
  try {
    const db = req.app.get("db");

    const email = (req.user?.email || "").toLowerCase();
    if (!email) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const month = new Date().toISOString().slice(0, 7);

    /*
      Cost is calculated from alerts table (source of truth)
      grouped by location
    */
    const rows = await db.all(
      `
      SELECT
        l.id           AS location_id,
        l.name         AS location_name,
        COUNT(a.id)    AS scans_used,
        ROUND(IFNULL(SUM(a.cost),0), 3) AS total_cost
      FROM locations l
      LEFT JOIN zones z
        ON z.location_id = l.id
      LEFT JOIN alerts a
        ON a.zone_id = z.id
       AND strftime('%Y-%m', a.timestamp) = ?
      WHERE l.user_email = ?
      GROUP BY l.id
      ORDER BY l.created_at ASC
      `,
      month,
      email
    );

    res.json({
      month,
      locations: rows
    });
  } catch (err) {
    console.error("Cost summary error:", err);
    res.status(500).json({ error: "Failed to load cost summary" });
  }
});

/* =========================
   OVERALL TOTAL
   GET /api/cost/total
========================= */
router.get("/total", requireAuth, async (req, res) => {
  try {
    const db = req.app.get("db");

    const email = (req.user?.email || "").toLowerCase();
    if (!email) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const month = new Date().toISOString().slice(0, 7);

    const row = await db.get(
      `
      SELECT
        COUNT(id) AS scans_used,
        ROUND(IFNULL(SUM(cost),0), 3) AS total_cost
      FROM alerts
      WHERE user_email = ?
        AND strftime('%Y-%m', timestamp) = ?
      `,
      email,
      month
    );

    res.json({
      month,
      scans_used: row?.scans_used || 0,
      total_cost: row?.total_cost || 0
    });
  } catch (err) {
    console.error("Cost total error:", err);
    res.status(500).json({ error: "Failed to load totals" });
  }
});

export default router;
