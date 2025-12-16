import express from "express";
import multer from "multer";
import jwt from "jsonwebtoken";
import {
  IndexFacesCommand,
  DeleteFacesCommand
} from "@aws-sdk/client-rekognition";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// -----------------------------
// AUTH
// -----------------------------
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// =======================================================
// ADD KNOWN FACE
// POST /api/known-faces/add
// EXPECTS: email, label, image
// =======================================================
router.post(
  "/add",
  requireAuth,
  upload.single("image"),
  async (req, res) => {
    try {
      const email = (req.body.email || "").toLowerCase();
      const label = (req.body.label || "").trim();

      if (!email || !label || !req.file) {
        return res.status(400).json({ error: "Missing data" });
      }

      const [first_name, last_name = ""] = label.split(" ");
      const db = req.app.get("db");
      const rekognition = req.app.get("rekognition");

      // Create person
      const result = await db.run(
        `INSERT INTO known_faces (user_email, first_name, last_name)
         VALUES (?,?,?)`,
        email,
        first_name,
        last_name
      );

      const knownFaceId = result.lastID;

      // Index into Rekognition
      const response = await rekognition.send(
        new IndexFacesCommand({
          CollectionId: process.env.REKOG_COLLECTION_ID,
          Image: { Bytes: req.file.buffer },
          ExternalImageId: `${email}_${knownFaceId}`,
          DetectionAttributes: []
        })
      );

      if (!response.FaceRecords?.length) {
        return res.status(400).json({ error: "No face detected in image" });
      }

      const faceId = response.FaceRecords[0].Face.FaceId;

      await db.run(
        `INSERT INTO known_face_images (known_face_id, face_id)
         VALUES (?,?)`,
        knownFaceId,
        faceId
      );

      res.json({
        ok: true,
        person: {
          id: knownFaceId,
          first_name,
          last_name,
          images: 1
        }
      });
    } catch (err) {
      console.error("add known face error:", err);
      res.status(500).json({ error: "Failed to add known face" });
    }
  }
);

// =======================================================
// LIST KNOWN FACES
// GET /api/known-faces/list?email=
// =======================================================
router.get("/list", requireAuth, async (req, res) => {
  try {
    const email = (req.query.email || "").toLowerCase();
    const db = req.app.get("db");

    const rows = await db.all(
      `
      SELECT kf.id, kf.first_name, kf.last_name,
             COUNT(kfi.id) as images
      FROM known_faces kf
      LEFT JOIN known_face_images kfi
      ON kf.id = kfi.known_face_id
      WHERE kf.user_email = ?
      GROUP BY kf.id
      ORDER BY kf.created_at DESC
      `,
      email
    );

    res.json(rows);
  } catch (err) {
    console.error("list known faces error:", err);
    res.status(500).json({ error: "Failed to load known faces" });
  }
});

// =======================================================
// DELETE KNOWN FACE (DB + REKOGNITION)
// DELETE /api/known-faces/:id
// =======================================================
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const db = req.app.get("db");
    const rekognition = req.app.get("rekognition");
    const id = Number(req.params.id);

    const images = await db.all(
      `SELECT face_id FROM known_face_images WHERE known_face_id=?`,
      id
    );

    if (images.length) {
      await rekognition.send(
        new DeleteFacesCommand({
          CollectionId: process.env.REKOG_COLLECTION_ID,
          FaceIds: images.map((i) => i.face_id)
        })
      );
    }

    await db.run(`DELETE FROM known_face_images WHERE known_face_id=?`, id);
    await db.run(`DELETE FROM known_faces WHERE id=?`, id);

    res.json({ ok: true });
  } catch (err) {
    console.error("delete known face error:", err);
    res.status(500).json({ error: "Delete failed" });
  }
});

export default router;
