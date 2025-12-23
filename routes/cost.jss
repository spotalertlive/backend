// backend/routes/cost.js
import express from "express";
import jwt from "jsonwebtoken";

const router = express.Router();

/* =========================
   PLAN LIMITS (LOCKED)
========================= */
const PLAN_LIMITS = {
  "Free Trial": 200,
  "Standard": 3000,
  "Premium": 10000,
  "Elite": 35000
};

/* =========================
   JWT AUTH
========================= */
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

/* =========================
   INTERNAL: GET MONTHLY USAGE
========================= */
async function getMonthlyUsage(db, email) {
  const month = new Date().toISOString().slice(0, 7);

  const row = await db.get(
    `
    SELECT COUNT(id) AS scans_used
    FROM alerts
    WHERE user_email = ?
      AND strftime('%Y-%m', timestamp) = ?
    `,
    email,
    month
  );

  return row?.scans_used || 0;
}

/* =========================
   HARD LIMIT GUARD (BLOCK)
========================= */
export async function enforcePlanLimit(req, res, next) {
  try {
    const db = req.app.get("db");
    const email = (req.user?.email || "").toLowerCase();

    const user = await db.get(
      "SELECT plan FROM users WHERE email=?",
      email
    );
    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }

    const limit = PLAN_LIMITS[user.plan];
    if (!limit) return next(); // safety

    const used = await getMonthlyUsage(db, email);

    if (used >= limit) {
      return res.status(403).json({
        error: "Monthly scan limit reached",
        plan: user.plan,
        scans_used: used,
        limit
      });
    }

    next();
  } catch (err) {
    console.error("Plan enforcement error:", err);
    res.status(500).json({ error: "Plan enforcement failed" });
  }
}

/* =========================
   MONTHLY SUMMARY + WARNINGS
   GET /api/cost/summary
========================= */
router.get("/summary", requireAuth, async (req, res) => {
  try {
    const db = req.app.get("db");
    const email = (req.user.email || "").toLowerCase();
    const month = new Date().toISOString().slice(0, 7);

    const user = await db.get(
      "SELECT plan FROM users WHERE email=?",
      email
    );

    const limit = PLAN_LIMITS[user?.plan] || null;
    const used = await getMonthlyUsage(db, email);

    const warning =
      limit && used >= limit * 0.8
        ? used >= limit
          ? "LIMIT_REACHED"
          : "NEAR_LIMIT"
        : null;

    const locations = await db.all(
      `
      SELECT
        l.id           AS location_id,
        l.name         AS location_name,
        COUNT(a.id)    AS scans_used,
        ROUND(IFNULL(SUM(a.cost),0), 3) AS total_cost
      FROM locations l
      LEFT JOIN zones z ON z.location_id = l.id
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
      plan: user?.plan,
      scans_used: used,
      scan_limit: limit,
      warning,
      locations
    });
  } catch (err) {
    console.error("Cost summary error:", err);
    res.status(500).json({ error: "Failed to load cost summary" });
  }
});

/* =========================
   TOTAL SUMMARY
   GET /api/cost/total
========================= */
router.get("/total", requireAuth, async (req, res) => {
  try {
    const db = req.app.get("db");
    const email = (req.user.email || "").toLowerCase();
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
