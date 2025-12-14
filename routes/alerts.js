import express from "express";
import jwt from "jsonwebtoken";
import fs from "fs";
import path from "path";

const router = express.Router();

// -----------------------------
// JWT auth (reuse same secret)
// -----------------------------
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { email, plan, ... }
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// -----------------------------
// GET /api/alerts/list?type=unknown|known|all
// returns alerts for logged-in user
// -----------------------------
router.get("/list", requireAuth, async (req, res) => {
  try {
    const db = req.app.get("db");
    if (!db) return res.status(500).json({ error: "DB not ready" });

    const email = (req.user.email || "").toLowerCase();
    const type = (req.query.type || "unknown").toLowerCase(); // default unknown

    let rows = [];
    if (type === "all") {
      rows = await db.all(
        `SELECT id,user_email,type,image_key,channel,cost,timestamp
         FROM alerts
         WHERE user_email=?
         ORDER BY timestamp DESC
         LIMIT 200`,
        email
      );
    } else {
      rows = await db.all(
        `SELECT id,user_email,type,image_key,channel,cost,timestamp
         FROM alerts
         WHERE user_email=? AND type=?
         ORDER BY timestamp DESC
         LIMIT 200`,
        email,
        type
      );
    }

    // add an image endpoint URL (no nginx static needed)
    const base = process.env.API_BASE_URL || ""; // optional
    const mapped = rows.map((r) => ({
      ...r,
      image_url: r.image_key ? `${base}/api/alerts/${r.id}/image` : null
    }));

    res.json(mapped);
  } catch (err) {
    console.error("alerts list error:", err);
    res.status(500).json({ error: "Failed to load alerts" });
  }
});

// -----------------------------
// GET /api/alerts/:id/image
// streams the stored image for this alert (only owner)
// -----------------------------
router.get("/:id/image", requireAuth, async (req, res) => {
  try {
    const db = req.app.get("db");
    if (!db) return res.status(500).json({ error: "DB not ready" });

    const email = (req.user.email || "").toLowerCase();
    const id = Number(req.params.id);

    const row = await db.get(
      `SELECT id,user_email,image_key FROM alerts WHERE id=?`,
      id
    );

    if (!row) return res.status(404).json({ error: "Not found" });
    if ((row.user_email || "").toLowerCase() !== email)
      return res.status(403).json({ error: "Forbidden" });

    if (!row.image_key) return res.status(404).json({ error: "No image" });

    const filePath = path.resolve(row.image_key);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Missing file" });

    // basic content type
    res.setHeader("Content-Type", "image/jpeg");
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error("alert image error:", err);
    res.status(500).json({ error: "Failed to load image" });
  }
});

// -----------------------------
// DELETE /api/alerts/:id
// deletes DB row + local image (only owner)
// -----------------------------
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const db = req.app.get("db");
    if (!db) return res.status(500).json({ error: "DB not ready" });

    const email = (req.user.email || "").toLowerCase();
    const id = Number(req.params.id);

    const row = await db.get(
      `SELECT id,user_email,image_key FROM alerts WHERE id=?`,
      id
    );

    if (!row) return res.status(404).json({ error: "Not found" });
    if ((row.user_email || "").toLowerCase() !== email)
      return res.status(403).json({ error: "Forbidden" });

    // delete file if exists
    if (row.image_key) {
      const filePath = path.resolve(row.image_key);
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (e) {
        console.warn("Could not delete image file:", e.message);
      }
    }

    await db.run(`DELETE FROM alerts WHERE id=?`, id);

    res.json({ ok: true });
  } catch (err) {
    console.error("delete alert error:", err);
    res.status(500).json({ error: "Delete failed" });
  }
});

export default router;
