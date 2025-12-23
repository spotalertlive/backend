// backend/middleware/planGuard.js

export function planGuard(feature) {
  const limits = {
    "Free Trial": { cameras: 2, scans: 200 },
    "Standard":   { cameras: 4, scans: 3000 },
    "Premium":    { cameras: 8, scans: 10000 },
    "Elite":      { cameras: 22, scans: 35000 }
  };

  return async (req, res, next) => {
    try {
      const email = req.user?.email?.toLowerCase();
      if (!email) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const db = req.app.get("db");
      if (!db) {
        return res.status(500).json({ error: "DB not ready" });
      }

      // =========================
      // USER PLAN
      // =========================
      const user = await db.get(
        "SELECT plan FROM users WHERE email=?",
        email
      );

      if (!user || !limits[user.plan]) {
        return res.status(403).json({ error: "Invalid plan" });
      }

      const plan = limits[user.plan];

      // =========================
      // CAMERA LIMIT
      // =========================
      if (feature === "camera") {
        const row = await db.get(
          "SELECT COUNT(*) AS cnt FROM cameras WHERE user_email=?",
          email
        );

        if ((row?.cnt || 0) >= plan.cameras) {
          return res.status(403).json({
            error: "Camera limit reached",
            plan: user.plan,
            limit: plan.cameras
          });
        }
      }

      // =========================
      // SCAN LIMIT (MONTHLY)
      // SOURCE OF TRUTH = alerts
      // =========================
      if (feature === "scan") {
        const month = new Date().toISOString().slice(0, 7); // YYYY-MM

        const row = await db.get(
          `
          SELECT COUNT(*) AS used
          FROM alerts
          WHERE user_email=?
            AND strftime('%Y-%m', timestamp)=?
          `,
          email,
          month
        );

        const used = row?.used || 0;

        if (used >= plan.scans) {
          return res.status(403).json({
            error: "Monthly scan limit reached",
            plan: user.plan,
            used,
            limit: plan.scans
          });
        }
      }

      next();
    } catch (err) {
      console.error("planGuard error:", err);
      return res.status(500).json({ error: "Plan enforcement failed" });
    }
  };
}
