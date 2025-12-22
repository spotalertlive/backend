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
   CREATE / UPDATE ZONE RULE
   POST /api/zones/rule
========================= */
router.post("/rule", async (req, res) => {
  try {
    const user = requireUser(req);
    if (!user?.email) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const db = req.app.get("db");
    if (!db) return res.status(500).json({ error: "DB not ready" });

    const zoneId = Number(req.body.zone_id);
    const ruleType = String(req.body.rule_type || "");
    const alertInterval = Math.max(
      1,
      Math.min(Number(req.body.alert_interval || 10), 1440)
    ); // 1 min → 24h

    if (!zoneId || !ruleType) {
      return res.status(400).json({ error: "Missing rule data" });
    }

    const allowed = ["known_only", "unknown_only", "mixed"];
    if (!allowed.includes(ruleType)) {
      return res.status(400).json({ error: "Invalid rule type" });
    }

    // 🔐 Verify zone ownership
    const zone = await db.get(
      `
      SELECT z.id
      FROM zones z
      JOIN locations l ON z.location_id = l.id
      WHERE z.id=? AND l.user_email=?
      `,
      zoneId,
      user.email.toLowerCase()
    );

    if (!zone) {
      return res.status(403).json({ error: "Zone not owned by user" });
    }

    // UPSERT rule
    const existing = await db.get(
      "SELECT id FROM zone_rules WHERE zone_id=?",
      zoneId
    );

    if (existing) {
      await db.run(
        `UPDATE zone_rules
         SET rule_type=?, alert_interval=?
         WHERE zone_id=?`,
        ruleType,
        alertInterval,
        zoneId
      );
    } else {
      await db.run(
        `INSERT INTO zone_rules (zone_id, rule_type, alert_interval)
         VALUES (?,?,?)`,
        zoneId,
        ruleType,
        alertInterval
      );
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Zone rule save error:", err);
    res.status(500).json({ error: "Failed to save zone rule" });
  }
});

/* =========================
   GET RULE BY ZONE
   GET /api/zones/rule/:zoneId
========================= */
router.get("/rule/:zoneId", async (req, res) => {
  try {
    const user = requireUser(req);
    if (!user?.email) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const db = req.app.get("db");
    const zoneId = Number(req.params.zoneId);
    if (!zoneId) {
      return res.status(400).json({ error: "Invalid zone id" });
    }

    // ownership check
    const zone = await db.get(
      `
      SELECT z.id
      FROM zones z
      JOIN locations l ON z.location_id = l.id
      WHERE z.id=? AND l.user_email=?
      `,
      zoneId,
      user.email.toLowerCase()
    );

    if (!zone) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const rule = await db.get(
      `SELECT zone_id, rule_type, alert_interval
       FROM zone_rules
       WHERE zone_id=?`,
      zoneId
    );

    res.json(rule || {});
  } catch (err) {
    console.error("Zone rule load error:", err);
    res.status(500).json({ error: "Failed to load rule" });
  }
});

/* =========================
   DELETE RULE
   DELETE /api/zones/rule/:zoneId
========================= */
router.delete("/rule/:zoneId", async (req, res) => {
  try {
    const user = requireUser(req);
    if (!user?.email) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const db = req.app.get("db");
    const zoneId = Number(req.params.zoneId);
    if (!zoneId) {
      return res.status(400).json({ error: "Invalid zone id" });
    }

    await db.run(
      `
      DELETE FROM zone_rules
      WHERE zone_id IN (
        SELECT z.id
        FROM zones z
        JOIN locations l ON z.location_id = l.id
        WHERE z.id=? AND l.user_email=?
      )
      `,
      zoneId,
      user.email.toLowerCase()
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("Zone rule delete error:", err);
    res.status(500).json({ error: "Failed to delete rule" });
  }
});

export default router;
