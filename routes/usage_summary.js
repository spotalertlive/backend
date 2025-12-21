// backend/routes/usage-summary.js

import express from "express";
import jwt from "jsonwebtoken";
import { calculateUsage } from "../utils/billingCalculator.js";

const router = express.Router();

// GET /api/usage-summary
router.get("/", async (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing token" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const email = decoded.email.toLowerCase();

    const db = req.app.get("db");
    if (!db) return res.status(500).json({ error: "DB not ready" });

    // User
    const user = await db.get(
      "SELECT plan FROM users WHERE email=?",
      email
    );
    if (!user) return res.status(404).json({ error: "User not found" });

    // Plan
    const plan = await db.get(
      "SELECT * FROM plans WHERE name=?",
      user.plan
    );
    if (!plan) return res.status(500).json({ error: "Plan missing" });

    // Alerts (current month)
    const alerts = await db.all(
      `
      SELECT cost
      FROM alerts
      WHERE user_email=?
        AND strftime('%Y-%m', timestamp) = strftime('%Y-%m', 'now')
      `,
      email
    );

    const summary = calculateUsage({ plan, alerts });

    res.json({
      month: new Date().toISOString().slice(0, 7),
      ...summary,
    });

  } catch (err) {
    console.error("usage-summary error:", err);
    res.status(500).json({ error: "Usage calculation failed" });
  }
});

export default router;
