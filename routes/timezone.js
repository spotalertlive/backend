// routes/timezone.js
import express from "express";
import jwt from "jsonwebtoken";

const router = express.Router();

/* =========================
   AUTH HELPER
========================= */
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

/* =========================
   SAVE USER TIMEZONE (AUTH)
   POST /api/timezone
   body: { timezone }
========================= */
router.post("/", async (req, res) => {
  try {
    const user = requireUser(req);
    if (!user?.email) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const db = req.app.get("db");
    if (!db) return res.status(500).json({ error: "DB not ready" });

    const timezone = (req.body.timezone || "").trim();
    if (!timezone) {
      return res.status(400).json({ error: "Timezone required" });
    }

    await db.run(
      `UPDATE users SET timezone=? WHERE email=?`,
      timezone,
      user.email.toLowerCase()
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("timezone save error:", err);
    res.status(500).json({ error: "Failed to save timezone" });
  }
});

/* =========================
   OPTIONAL: LOG CLIENT EVENT (AUTH)
   POST /api/timezone/event
   body: { event }
========================= */
router.post("/event", async (req, res) => {
  try {
    const user = requireUser(req);
    if (!user?.email) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const event = (req.body.event || "").trim();
    if (!event) return res.json({ ok: true });

    const db = req.app.get("db");
    if (!db) return res.status(500).json({ error: "DB not ready" });

    await db.run(
      `INSERT INTO alerts (user_email, type, channel)
       VALUES (?,?,?)`,
      user.email.toLowerCase(),
      "client_event",
      event
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("event log error:", err);
    res.status(500).json({ error: "Failed to log event" });
  }
});

export default router;
