import express from "express";
import jwt from "jsonwebtoken";

const router = express.Router();

// POST /api/upgrade-plan
router.post("/", async (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing token" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const email = decoded.email;

    const { plan } = req.body;
    if (!plan) return res.status(400).json({ error: "Plan required" });

    const ALLOWED_PLANS = ["Free Trial", "Standard", "Premium", "Elite"];
    if (!ALLOWED_PLANS.includes(plan)) {
      return res.status(400).json({ error: "Invalid plan" });
    }

    // Elite is visible but locked
    if (plan === "Elite") {
      return res.status(403).json({ error: "Elite plan coming soon" });
    }

    const db = req.app.get("db");
    if (!db) return res.status(500).json({ error: "DB not ready" });

    const user = await db.get(
      "SELECT id, plan FROM users WHERE email=?",
      email.toLowerCase()
    );

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    await db.run(
      "UPDATE users SET plan=? WHERE email=?",
      plan,
      email.toLowerCase()
    );

    res.json({ success: true, plan });

  } catch (err) {
    console.error("upgrade-plan error:", err);
    res.status(500).json({ error: "Upgrade failed" });
  }
});

export default router;
