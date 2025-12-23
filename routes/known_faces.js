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
// AUTH (JWT)
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
// POST /api/known_faces/add
// body: { label }
// file: image
// =======================================================
router.post(
  "/add",
  requireAuth,
  upload.single("image"),
  async (req, res) => {
    const db = req.app.get("db");
    const rekognition = req.app.get("rekognition");

    try {
      const email = req.user.email.toLowerCase(); // 🔒 TRUST JWT ONLY
      const label = (req.body.label || "").trim();

      if (!label || !req.file?.buffer) {
        return res.status(400).json({ error: "Missing label or image" });
      }

      const [first_name, ...rest] = label.split(" ");
      const last_name = rest.join(" ");

      // 1️⃣ Create person in DB
      const result = await db.run(
        `INSERT INTO known_faces (user_email, first_name, last_name)
         VALUES (?,?,?)`,
        email,
        first_name,
        last_name
      );

      const knownFaceId = result.lastID;

      // 2️⃣ Index face in Rekognition
      let faceId;
      try {
        const response = await rekognition.send(
          new IndexFacesCommand({
            CollectionId: process.env.REKOG_COLLECTION_ID,
            Image: { Bytes: req.file.buffer },
            ExternalImageId: `${email}:${knownFaceId}`,
            DetectionAttributes: []
          })
        );

        if (!response.FaceRecords?.length) {
          throw new Error("No face detected");
        }

        faceId = response.FaceRecords[0].Face.FaceId;
      } catch (err) {
        // 🔥 rollback DB insert
        await db.run(`DELETE FROM known_faces WHERE id=?`, knownFaceId);
        throw err;
      }

      // 3️⃣ Save face mapping
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
// LIST KNOWN FACES (JWT OWNER ONLY)
// GET /api/known_faces/list
// =======================================================
router.get("/list", requireAuth, async (req, res) => {
  try {
    const db = req.app.get("db");
    const email = req.user.email.toLowerCase(); // 🔒 JWT only

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
// DELETE KNOWN FACE (OWNER ONLY)
// DELETE /api/known_faces/:id
// =======================================================
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const db = req.app.get("db");
    const rekognition = req.app.get("rekognition");
    const email = req.user.email.toLowerCase();
    const id = Number(req.params.id);

    // ownership check
    const person = await db.get(
      `SELECT id FROM known_faces WHERE id=? AND user_email=?`,
      id,
      email
    );
    if (!person) {
      return res.status(404).json({ error: "Not found" });
    }

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
