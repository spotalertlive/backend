export function planGuard(feature) {
  const limits = {
    "Free Trial": { cameras: 2, scans: 200 },
    "Standard": { cameras: 4, scans: 3000 },
    "Premium": { cameras: 8, scans: 10000 },
    "Elite": { cameras: 22, scans: 35000 }
  };

  return async (req, res, next) => {
    const email = req.user?.email;
    if (!email) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const db = req.app.get("db");

    const user = await db.get(
      "SELECT plan FROM users WHERE email=?",
      email
    );
    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }

    const plan = limits[user.plan];
    if (!plan) {
      return res.status(403).json({ error: "Invalid plan" });
    }

    // -------------------------
    // CAMERA LIMIT
    // -------------------------
    if (feature === "camera") {
      const count = await db.get(
        "SELECT COUNT(*) as cnt FROM cameras WHERE user_email=?",
        email
      );

      if (count.cnt >= plan.cameras) {
        return res.status(403).json({
          error: "Camera limit reached for your plan"
        });
      }
    }

    // -------------------------
    // SCAN LIMIT (MONTHLY)
    // -------------------------
    if (feature === "scan") {
      const month = new Date().toISOString().slice(0, 7); // YYYY-MM

      const usage = await db.get(
        `
        SELECT SUM(scans_used) as used
        FROM usage_costs
        WHERE user_email=? AND month=?
        `,
        email,
        month
      );

      const used = usage?.used || 0;

      if (used >= plan.scans) {
        return res.status(403).json({
          error: "Scan limit reached for your plan"
        });
      }
    }

    next();
  };
}
