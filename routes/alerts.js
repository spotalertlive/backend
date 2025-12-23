import express from "express";
import jwt from "jsonwebtoken";
import {
  GetObjectCommand,
  DeleteObjectCommand
} from "@aws-sdk/client-s3";

const router = express.Router();

// -----------------------------
// JWT auth
// -----------------------------
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { email, plan }
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

function bucket() {
  return (
    process.env.S3_BUCKET ||
    process.env.S3_BUCKET_NAME ||
    process.env.S3_BUCKET_ALERTS
  );
}

// -----------------------------
// GET /api/alerts/list
// -----------------------------
router.get("/list", requireAuth, async (req, res) => {
  try {
    const db = req.app.get("db");
    const email = (req.user.email || "").toLowerCase();
    const type = (req.query.type || "unknown").toLowerCase();

    let rows;
    if (type === "all") {
      rows = await db.all(
        `SELECT id,type,image_key,channel,cost,pinned,timestamp
         FROM alerts
         WHERE user_email=?
         ORDER BY timestamp DESC
         LIMIT 200`,
        email
      );
    } else {
      rows = await db.all(
        `SELECT id,type,image_key,channel,cost,pinned,timestamp
         FROM alerts
         WHERE user_email=? AND type=?
         ORDER BY timestamp DESC
         LIMIT 200`,
        email,
        type
      );
    }

    const base = process.env.API_BASE_URL || "";
    const out = rows.map(r => ({
      ...r,
      image_url: r.image_key
        ? `${base}/api/alerts/${r.id}/image`
        : null
    }));

    res.json(out);
  } catch (e) {
    console.error("alerts list error:", e);
    res.status(500).json({ error: "Failed to load alerts" });
  }
});

// -----------------------------
// GET /api/alerts/:id/image  (S3 STREAM)
// -----------------------------
router.get("/:id/image", requireAuth, async (req, res) => {
  try {
    const db = req.app.get("db");
    const s3 = req.app.get("s3");

    const email = (req.user.email || "").toLowerCase();
    const id = Number(req.params.id);

    const row = await db.get(
      "SELECT user_email,image_key FROM alerts WHERE id=?",
      id
    );

    if (!row) return res.status(404).json({ error: "Not found" });
    if (row.user_email.toLowerCase() !== email)
      return res.status(403).json({ error: "Forbidden" });
    if (!row.image_key)
      return res.status(404).json({ error: "No image" });

    const obj = await s3.send(
      new GetObjectCommand({
        Bucket: bucket(),
        Key: row.image_key
      })
    );

    res.setHeader("Content-Type", obj.ContentType || "image/jpeg");
    res.setHeader("Cache-Control", "no-store");
    obj.Body.pipe(res);
  } catch (e) {
    console.error("alert image error:", e);
    res.status(500).json({ error: "Failed to load image" });
  }
});

// -----------------------------
// DELETE /api/alerts/:id  (DB + S3)
// -----------------------------
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const db = req.app.get("db");
    const s3 = req.app.get("s3");

    const email = (req.user.email || "").toLowerCase();
    const id = Number(req.params.id);

    const row = await db.get(
      "SELECT user_email,image_key FROM alerts WHERE id=?",
      id
    );

    if (!row) return res.status(404).json({ error: "Not found" });
    if (row.user_email.toLowerCase() !== email)
      return res.status(403).json({ error: "Forbidden" });

    if (row.image_key) {
      try {
        await s3.send(
          new DeleteObjectCommand({
            Bucket: bucket(),
            Key: row.image_key
          })
        );
      } catch (e) {
        console.warn("S3 delete warning:", e.message);
      }
    }

    await db.run("DELETE FROM alerts WHERE id=?", id);
    res.json({ ok: true });
  } catch (e) {
    console.error("delete alert error:", e);
    res.status(500).json({ error: "Delete failed" });
  }
});

export default router;
