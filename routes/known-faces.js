import express from "express";
import multer from "multer";
import { IndexFacesCommand } from "@aws-sdk/client-rekognition";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// =======================================================
// ADD KNOWN PERSON (up to 3 images)
// POST /api/known-faces/add
// =======================================================
router.post("/add", upload.array("images", 3), async (req, res) => {
  try {
    const { first_name, last_name, email } = req.body;

    if (!first_name || !last_name || !email) {
      return res.status(400).json({ error: "Missing fields" });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "At least one image required" });
    }

    const db = req.app.get("db");
    const rekognition = req.app.get("rekognition");

    if (!db || !rekognition) {
      return res.status(500).json({ error: "Backend not initialised" });
    }

    // 🔒 Soft limit (can be adjusted later)
    const countRow = await db.get(
      "SELECT COUNT(*) as cnt FROM known_faces WHERE user_email=?",
      email.toLowerCase()
    );

    if (countRow.cnt >= 50) {
      return res.status(400).json({ error: "Known faces limit reached" });
    }

    // 1️⃣ Create person
    const result = await db.run(
      `INSERT INTO known_faces (user_email, first_name, last_name)
       VALUES (?,?,?)`,
      email.toLowerCase(),
      first_name,
      last_name
    );

    const knownFaceId = result.lastID;
    let indexed = 0;

    // 2️⃣ Index each image
    for (const file of req.files) {
      const response = await rekognition.send(
        new IndexFacesCommand({
          CollectionId: process.env.REKOG_COLLECTION_ID,
          Image: { Bytes: file.buffer },
          ExternalImageId: `${first_name}_${last_name}`,
          DetectionAttributes: []
        })
      );

      if (response.FaceRecords?.length) {
        const faceId = response.FaceRecords[0].Face.FaceId;

        await db.run(
          `INSERT INTO known_face_images (known_face_id, face_id)
           VALUES (?,?)`,
          knownFaceId,
          faceId
        );

        indexed++;
      }
    }

    // ✅ Return real data for dashboard
    res.json({
      ok: true,
      person: {
        id: knownFaceId,
        first_name,
        last_name,
        images: indexed
      }
    });

  } catch (err) {
    console.error("add known face error:", err);
    res.status(500).json({ error: "Failed to add known face" });
  }
});

// =======================================================
// LIST KNOWN FACES (dashboard)
// GET /api/known-faces/list?email=
// =======================================================
router.get("/list", async (req, res) => {
  try {
    const email = (req.query.email || "").toLowerCase();
    const db = req.app.get("db");

    if (!db) {
      return res.status(500).json({ error: "Backend not initialised" });
    }

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
// DELETE PERSON
// DELETE /api/known-faces/:id
// =======================================================
router.delete("/:id", async (req, res) => {
  try {
    const db = req.app.get("db");

    if (!db) {
      return res.status(500).json({ error: "Backend not initialised" });
    }

    await db.run("DELETE FROM known_faces WHERE id=?", req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error("delete known face error:", err);
    res.status(500).json({ error: "Delete failed" });
  }
});

export default router;
