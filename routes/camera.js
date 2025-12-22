// routes/camera.js
import express from "express";
import jwt from "jsonwebtoken";

const router = express.Router();

/* =========================
   AUTH HELPER
========================= */
function requireUser(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;

  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
}

/* =========================
   REGISTER CAMERA (AUTH)
   POST /api/camera/register
   body: { name, ip }
========================= */
router.post("/register", async (req, res) => {
  try {
    const user = requireUser(req);
    if (!user?.email) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const db = req.app.get("db");
    if (!db) return res.status(500).json({ error: "DB not ready" });

    const name = (req.body.name || "").trim();
    const ip = (req.body.ip || "").trim();

    if (!name || !ip) {
      return res.status(400).json({ error: "Missing fields" });
    }

    await db.run(
      `INSERT INTO cameras (user_email, name, ip)
       VALUES (?,?,?)`,
      user.email.toLowerCase(),
      name,
      ip
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("camera register error:", err);
    res.status(500).json({ error: "Camera register failed" });
  }
});

/* =========================
   LIST CAMERAS (AUTH)
   GET /api/camera/list
========================= */
router.get("/list", async (req, res) => {
  try {
    const user = requireUser(req);
    if (!user?.email) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const db = req.app.get("db");
    if (!db) return res.status(500).json({ error: "DB not ready" });

    const rows = await db.all(
      `SELECT id, name, ip, created_at
       FROM cameras
       WHERE user_email=?
       ORDER BY created_at DESC`,
      user.email.toLowerCase()
    );

    res.json(rows);
  } catch (err) {
    console.error("camera list error:", err);
    res.status(500).json({ error: "Failed to load cameras" });
  }
});

/* =========================
   DELETE CAMERA (AUTH)
   DELETE /api/camera/:id
========================= */
router.delete("/:id", async (req, res) => {
  try {
    const user = requireUser(req);
    if (!user?.email) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const db = req.app.get("db");
    if (!db) return res.status(500).json({ error: "DB not ready" });

    const id = Number(req.params.id);
    if (!id) {
      return res.status(400).json({ error: "Invalid camera id" });
    }

    const result = await db.run(
      `DELETE FROM cameras
       WHERE id=? AND user_email=?`,
      id,
      user.email.toLowerCase()
    );

    if (result.changes === 0) {
      return res.status(404).json({ error: "Camera not found" });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("camera delete error:", err);
    res.status(500).json({ error: "Delete failed" });
  }
});

export default router;
