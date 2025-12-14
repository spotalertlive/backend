// routes/cctv.js
import express from "express";
import multer from "multer";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { detectAndHandle } from "../services/detection.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

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

// =======================================================
// REGISTER CAMERA (AUTH)
// POST /api/cctv/register
// body: { name, location }
// returns: { cameraId, api_key }
// =======================================================
router.post("/register", async (req, res) => {
  try {
    const user = requireUser(req);
    if (!user?.email) return res.status(401).json({ error: "Unauthorized" });

    const { name, location } = req.body || {};
    if (!name) return res.status(400).json({ error: "Camera name required" });

    const db = req.app.get("db");
    if (!db) return res.status(500).json({ error: "DB not ready" });

    const apiKey = crypto.randomBytes(18).toString("hex");

    const r = await db.run(
      `INSERT INTO cameras (user_email, name, location, api_key)
       VALUES (?,?,?,?)`,
      user.email.toLowerCase(),
      String(name),
      String(location || ""),
      apiKey
    );

    res.json({ ok: true, cameraId: r.lastID, api_key: apiKey });
  } catch (e) {
    console.error("register camera error:", e);
    res.status(500).json({ error: "Failed to register camera" });
  }
});

// =======================================================
// LIST CAMERAS (AUTH)
// GET /api/cctv/list
// =======================================================
router.get("/list", async (req, res) => {
  try {
    const user = requireUser(req);
    if (!user?.email) return res.status(401).json({ error: "Unauthorized" });

    const db = req.app.get("db");
    if (!db) return res.status(500).json({ error: "DB not ready" });

    const rows = await db.all(
      `SELECT id, name, location, created_at
       FROM cameras
       WHERE user_email=?
       ORDER BY created_at DESC`,
      user.email.toLowerCase()
    );

    res.json(rows);
  } catch (e) {
    console.error("list cameras error:", e);
    res.status(500).json({ error: "Failed to list cameras" });
  }
});

// =======================================================
// DELETE CAMERA (AUTH)
// DELETE /api/cctv/:id
// =======================================================
router.delete("/:id", async (req, res) => {
  try {
    const user = requireUser(req);
    if (!user?.email) return res.status(401).json({ error: "Unauthorized" });

    const db = req.app.get("db");
    if (!db) return res.status(500).json({ error: "DB not ready" });

    await db.run(
      `DELETE FROM cameras WHERE id=? AND user_email=?`,
      req.params.id,
      user.email.toLowerCase()
    );

    res.json({ ok: true });
  } catch (e) {
    console.error("delete camera error:", e);
    res.status(500).json({ error: "Failed to delete camera" });
  }
});

// =======================================================
// CCTV SNAPSHOT INGEST (NO JWT)
// POST /api/cctv/:id/snapshot
// Headers: X-Camera-Key: <api_key>
// FormData: image=<file>
// =======================================================
router.post("/:id/snapshot", upload.single("image"), async (req, res) => {
  try {
    const cameraKey = req.headers["x-camera-key"] || "";
    if (!cameraKey) return res.status(401).json({ error: "Missing X-Camera-Key" });
    if (!req.file?.buffer) return res.status(400).json({ error: "Missing image file" });

    const db = req.app.get("db");
    if (!db) return res.status(500).json({ error: "DB not ready" });

    const cam = await db.get(
      `SELECT id, user_email, api_key FROM cameras WHERE id=?`,
      req.params.id
    );

    if (!cam) return res.status(404).json({ error: "Camera not found" });
    if (String(cam.api_key) !== String(cameraKey)) {
      return res.status(403).json({ error: "Invalid camera key" });
    }

    // ONE pipeline
    const result = await detectAndHandle({
      app: req.app,
      imageBuffer: req.file.buffer,
      userEmail: cam.user_email,
      source: "cctv",
      cameraId: cam.id,
      meta: { ip: req.ip }
    });

    res.json(result);
  } catch (e) {
    console.error("snapshot ingest error:", e);
    res.status(500).json({ error: "Snapshot ingest failed" });
  }
});

export default router;
