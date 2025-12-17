import express from "express";
const router = express.Router();

// =======================================================
// REGISTER CAMERA
// POST /api/camera/register
// =======================================================
router.post("/register", async (req, res) => {
  try {
    const db = req.app.get("db");
    const { name, ip, user_email } = req.body;

    if (!db) return res.status(500).json({ error: "DB not ready" });
    if (!name || !ip || !user_email) {
      return res.status(400).json({ error: "Missing fields" });
    }

    await db.run(
      `INSERT INTO cameras (user_email, name, ip)
       VALUES (?,?,?)`,
      user_email.toLowerCase(),
      name,
      ip
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("camera register error:", err);
    res.status(500).json({ error: "Camera register failed" });
  }
});

// =======================================================
// LIST CAMERAS (PER USER)
// GET /api/camera/list?email=
// =======================================================
router.get("/list", async (req, res) => {
  try {
    const db = req.app.get("db");
    const email = (req.query.email || "").toLowerCase();

    if (!db) return res.status(500).json({ error: "DB not ready" });
    if (!email) return res.status(400).json({ error: "Email required" });

    const rows = await db.all(
      `SELECT id, name, ip, created_at
       FROM cameras
       WHERE user_email=?
       ORDER BY created_at DESC`,
      email
    );

    res.json(rows);
  } catch (err) {
    console.error("camera list error:", err);
    res.status(500).json({ error: "Failed to load cameras" });
  }
});

// =======================================================
// DELETE CAMERA
// DELETE /api/camera/:id
// =======================================================
router.delete("/:id", async (req, res) => {
  try {
    const db = req.app.get("db");
    const id = Number(req.params.id);

    if (!db) return res.status(500).json({ error: "DB not ready" });
    if (!id) return res.status(400).json({ error: "Invalid camera id" });

    await db.run(`DELETE FROM cameras WHERE id=?`, id);
    res.json({ ok: true });
  } catch (err) {
    console.error("camera delete error:", err);
    res.status(500).json({ error: "Delete failed" });
  }
});

export default router;
