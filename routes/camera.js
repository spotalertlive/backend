import express from "express";
const router = express.Router();

// ================================
// ADD CAMERA
// POST /api/camera/add
// ================================
router.post("/add", async (req, res) => {
  try {
    const db = req.app.get("db");
    const { name, ip, email } = req.body;

    if (!name || !ip || !email) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const result = await db.run(
      `INSERT INTO cameras (user_email, name, ip)
       VALUES (?,?,?)`,
      email.toLowerCase(),
      name,
      ip
    );

    res.json({
      ok: true,
      camera: {
        id: result.lastID,
        name,
        ip
      }
    });
  } catch (err) {
    console.error("camera add error:", err);
    res.status(500).json({ error: "Failed to add camera" });
  }
});

// ================================
// LIST CAMERAS
// GET /api/camera/list?email=
// ================================
router.get("/list", async (req, res) => {
  try {
    const db = req.app.get("db");
    const email = (req.query.email || "").toLowerCase();

    const rows = await db.all(
      `SELECT id,name,ip,created_at
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

// ================================
// DELETE CAMERA
// DELETE /api/camera/:id
// ================================
router.delete("/:id", async (req, res) => {
  try {
    const db = req.app.get("db");
    const id = Number(req.params.id);

    await db.run(`DELETE FROM cameras WHERE id=?`, id);
    res.json({ ok: true });
  } catch (err) {
    console.error("camera delete error:", err);
    res.status(500).json({ error: "Delete failed" });
  }
});

export default router;
