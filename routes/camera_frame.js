import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { SearchFacesByImageCommand } from "@aws-sdk/client-rekognition";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// =======================================================
// CAMERA AUTH (token-based, NOT user JWT)
// =======================================================
async function requireCamera(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Camera ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing camera token" });

  const db = req.app.get("db");
  if (!db) return res.status(500).json({ error: "DB not ready" });

  const camera = await db.get(
    "SELECT * FROM cameras WHERE camera_token=?",
    token
  );

  if (!camera) return res.status(401).json({ error: "Invalid camera token" });

  req.camera = camera;
  next();
}

// =======================================================
// POST /api/camera/frame
// CCTV sends snapshot here
// =======================================================
router.post(
  "/",
  requireCamera,
  upload.single("image"),
  async (req, res) => {
    try {
      if (!req.file?.buffer) {
        return res.status(400).json({ error: "Missing image" });
      }

      const db = req.app.get("db");
      const rekognition = req.app.get("rekognition");
      const email = (req.camera.user_email || "").toLowerCase();

      // ---------------------------------------------------
      // 1. Face recognition
      // ---------------------------------------------------
      const result = await rekognition.send(
        new SearchFacesByImageCommand({
          CollectionId: process.env.REKOG_COLLECTION_ID,
          Image: { Bytes: req.file.buffer }
        })
      );

      const matches = result.FaceMatches || [];
      const isKnown = matches.length > 0;

      // ---------------------------------------------------
      // 2. Save image ONLY if unknown
      // ---------------------------------------------------
      let imagePath = null;

      if (!isKnown) {
        const dir = path.resolve("alert_images");
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const filename = `alert_${Date.now()}_${Math.random()
          .toString(36)
          .slice(2)}.jpg`;

        imagePath = path.join(dir, filename);
        fs.writeFileSync(imagePath, req.file.buffer);
      }

      // ---------------------------------------------------
      // 3. Save alert (unknown only)
      // ---------------------------------------------------
      if (!isKnown) {
        await db.run(
          `INSERT INTO alerts (user_email,type,image_key,channel,cost)
           VALUES (?,?,?,?,?)`,
          email,
          "unknown",
          imagePath,
          "camera",
          0.001
        );
      }

      // ---------------------------------------------------
      // 4. Respond to camera
      // ---------------------------------------------------
      res.json({
        ok: true,
        known: isKnown
      });
    } catch (err) {
      console.error("camera-frame error:", err);
      res.status(500).json({ error: "Camera processing failed" });
    }
  }
);

export default router;
