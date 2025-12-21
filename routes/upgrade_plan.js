import express from "express";
import jwt from "jsonwebtoken";

const router = express.Router();

// POST /api/upgrade-plan
// Handles BOTH upgrade and downgrade
router.post("/", async (req, res) => {
  try {
    // =========================
    // AUTH
    // =========================
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: "Missing token" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const email = decoded.email?.toLowerCase();
    if (!email) {
      return res.status(401).json({ error: "Invalid token" });
    }

    // =========================
    // INPUT
    // =========================
    const { plan } = req.body;
    if (!plan) {
      return res.status(400).json({ error: "Plan required" });
    }

    const ALLOWED_PLANS = ["Free Trial", "Standard", "Premium", "Elite"];
    if (!ALLOWED_PLANS.includes(plan)) {
      return res.status(400).json({ error: "Invalid plan" });
    }

    // Elite visible but locked
    if (plan === "Elite") {
      return res.status(403).json({ error: "Elite plan coming soon" });
    }

    const db = req.app.get("db");
    if (!db) {
      return res.status(500).json({ error: "DB not ready" });
    }

    // =========================
    // LOAD USER
    // =========================
    const user = await db.get(
      "SELECT id, plan FROM users WHERE email=?",
      email
    );

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const previousPlan = user.plan;

    // =========================
    // UPDATE PLAN
    // =========================
    await db.run(
      "UPDATE users SET plan=? WHERE email=?",
      plan,
      email
    );

    // =========================
    // DOWNGRADE → RESET USAGE
    // =========================
    const PLAN_ORDER = {
      "Free Trial": 1,
      "Standard": 2,
      "Premium": 3
    };

    const isDowngrade =
      PLAN_ORDER[plan] < PLAN_ORDER[previousPlan];

    if (isDowngrade) {
      // Reset usage counters safely
      await db.run(
        "DELETE FROM alerts WHERE user_email=?",
        email
      );
    }

    // =========================
    // RESPONSE
    // =========================
    res.json({
      success: true,
      plan,
      previousPlan,
      downgrade: isDowngrade
    });

  } catch (err) {
    console.error("upgrade-plan error:", err);
    res.status(500).json({ error: "Plan update failed" });
  }
});

export default router;
