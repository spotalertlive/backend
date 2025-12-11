import express from "express";
const router = express.Router();

let cameras = [];

// POST /api/camera/register
router.post("/camera/register", (req, res) => {
  const { name, ip, user_email } = req.body;

  if (!name || !ip) {
    return res.status(400).json({ error: "Camera name and IP required" });
  }

  const cam = {
    id: cameras.length + 1,
    name,
    ip,
    user_email,
    added_at: new Date().toISOString()
  };

  cameras.push(cam);
  res.json({ ok: true, camera: cam });
});

// GET /api/camera/list
router.get("/camera/list", (req, res) => {
  res.json(cameras);
});

// POST /api/camera/delete
router.post("/camera/delete", (req, res) => {
  const { id } = req.body;
  cameras = cameras.filter(c => c.id !== Number(id));
  res.json({ ok: true });
});

export default router;
