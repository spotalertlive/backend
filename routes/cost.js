import express from "express";
const router = express.Router();

/*
  COST + USAGE SUMMARY
  - Per user
  - Per location (house / cottage / plant)
  - Per month
*/

/* =========================
   MONTHLY SUMMARY
========================= */
router.get("/summary", async (req, res) => {
  try {
    const db = req.app.get("db");

    // auth already applied at server level
    const email = req.user?.email;
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
   OVERALL TOTAL (OPTIONAL)
========================= */
router.get("/total", async (req, res) => {
  try {
    const db = req.app.get("db");
    const email = req.user?.email;
    if (!email) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const month = new Date().toISOString().slice(0, 7);

    const row = await db.get(
      `
      SELECT
        COUNT(id) AS scans,
        ROUND(IFNULL(SUM(cost),0), 3) AS cost
      FROM alerts
      WHERE user_email = ?
        AND strftime('%Y-%m', timestamp) = ?
      `,
      email,
      month
    );

    res.json({
      month,
      scans_used: row?.scans || 0,
      total_cost: row?.cost || 0
    });
  } catch (err) {
    console.error("Cost total error:", err);
    res.status(500).json({ error: "Failed to load totals" });
  }
});

export default router;
