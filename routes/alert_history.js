// backend/routes/alert-history.js
import express from "express";
import jwt from "jsonwebtoken";

const router = express.Router();

// =======================================================
// GET /api/alert-history
// List unknown alerts for logged-in user
// =======================================================
router.get("/", async (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing token" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const email = decoded.email.toLowerCase();

    const db = req.app.get("db");

    const rows = await db.all(
      `SELECT id, image_path, camera_name, created_at
       FROM alert_history
       WHERE user_email = ?
       ORDER BY created_at DESC`,
      email
    );

    res.json(rows);
  } catch (err) {
    console.error("alert-history list error:", err);
    res.status(500).json({ error: "Failed to load alerts" });
  }
});

// =======================================================
// DELETE /api/alert-history/:id
// Delete a specific alert
// =======================================================
router.delete("/:id", async (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing token" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const email = decoded.email.toLowerCase();

    const db = req.app.get("db");

    const alert = await db.get(
      "SELECT id FROM alert_history WHERE id=? AND user_email=?",
      req.params.id,
      email
    );

    if (!alert) {
      return res.status(404).json({ error: "Alert not found" });
    }

    await db.run("DELETE FROM alert_history WHERE id=?", req.params.id);

    res.json({ success: true });
  } catch (err) {
    console.error("alert-history delete error:", err);
    res.status(500).json({ error: "Delete failed" });
  }
});

export default router;
