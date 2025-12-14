export function planGuard(feature) {
  const limits = {
    "Free Trial": { cameras: 2, scans: 200 },
    "Standard": { cameras: 4, scans: 3000 },
    "Premium": { cameras: 10, scans: 10000 },
    "Elite": { cameras: 999, scans: 999999 }
  };

  return async (req, res, next) => {
    const email = req.user?.email;
    if (!email) return res.status(401).json({ error: "Unauthorized" });

    const db = req.app.get("db");
    const user = await db.get("SELECT plan FROM users WHERE email=?", email);
    if (!user) return res.status(401).json({ error: "User not found" });

    const plan = limits[user.plan];
    if (!plan) return res.status(403).json({ error: "Invalid plan" });

    if (feature === "camera") {
      const count = await db.get(
        "SELECT COUNT(*) as cnt FROM cameras WHERE user_email=?",
        email
      );
      if (count.cnt >= plan.cameras)
        return res.status(403).json({ error: "Camera limit reached" });
    }

    next();
  };
}
