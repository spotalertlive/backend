// backend/routes/zone_rules.js
import express from "express";
import jwt from "jsonwebtoken";

const router = express.Router();

/* =========================
   AUTH (JWT)
========================= */
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

/* =========================
   CREATE / UPDATE ZONE RULE
   POST /api/zone_rules
   body: { zone_id, rule_type, alert_interval }
========================= */
router.post("/", requireAuth, async (req, res) => {
  try {
    const db = req.app.get("db");
    if (!db) return res.status(500).json({ error: "DB not ready" });

    const email = (req.user?.email || "").toLowerCase();
    if (!email) return res.status(401).json({ error: "Unauthorized" });

    const zoneId = Number(req.body.zone_id);
    const ruleType = String(req.body.rule_type || "").trim();

    // clamp 1 min → 1440 min (24h)
    const rawInterval = Number(req.body.alert_interval ?? 10);
    const alertInterval = Math.max(1, Math.min(rawInterval || 10, 1440));

    if (!zoneId || !ruleType) {
      return res.status(400).json({ error: "Missing rule data" });
    }

    const allowed = ["known_only", "unknown_only", "mixed"];
    if (!allowed.includes(ruleType)) {
      return res.status(400).json({ error: "Invalid rule type" });
    }

    // 🔐 Verify zone ownership (zone must belong to this user's location)
    const zone = await db.get(
      `
      SELECT z.id
      FROM zones z
      JOIN locations l ON l.id = z.location_id
      WHERE z.id=? AND l.user_email=?
      `,
      zoneId,
      email
    );

    if (!zone) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // ✅ UPSERT rule (1 query)
    await db.run(
      `
      INSERT INTO zone_rules (zone_id, rule_type, alert_interval)
      VALUES (?,?,?)
      ON CONFLICT(zone_id) DO UPDATE SET
        rule_type=excluded.rule_type,
        alert_interval=excluded.alert_interval
      `,
      zoneId,
      ruleType,
      alertInterval
    );

    return res.json({ ok: true, zone_id: zoneId, rule_type: ruleType, alert_interval: alertInterval });
  } catch (err) {
    console.error("Zone rule save error:", err);
    return res.status(500).json({ error: "Failed to save zone rule" });
  }
});

/* =========================
   GET RULE BY ZONE
   GET /api/zone_rules/:zoneId
========================= */
router.get("/:zoneId", requireAuth, async (req, res) => {
  try {
    const db = req.app.get("db");
    if (!db) return res.status(500).json({ error: "DB not ready" });

    const email = (req.user?.email || "").toLowerCase();
    const zoneId = Number(req.params.zoneId);

    if (!email) return res.status(401).json({ error: "Unauthorized" });
    if (!zoneId) return res.status(400).json({ error: "Invalid zone id" });

    // ownership check
    const zone = await db.get(
      `
      SELECT z.id
      FROM zones z
      JOIN locations l ON l.id = z.location_id
      WHERE z.id=? AND l.user_email=?
      `,
      zoneId,
      email
    );
    if (!zone) return res.status(403).json({ error: "Forbidden" });

    const rule = await db.get(
      `SELECT zone_id, rule_type, alert_interval
       FROM zone_rules
       WHERE zone_id=?`,
      zoneId
    );

    return res.json(rule || {});
  } catch (err) {
    console.error("Zone rule load error:", err);
    return res.status(500).json({ error: "Failed to load rule" });
  }
});

/* =========================
   DELETE RULE
   DELETE /api/zone_rules/:zoneId
========================= */
router.delete("/:zoneId", requireAuth, async (req, res) => {
  try {
    const db = req.app.get("db");
    if (!db) return res.status(500).json({ error: "DB not ready" });

    const email = (req.user?.email || "").toLowerCase();
    const zoneId = Number(req.params.zoneId);

    if (!email) return res.status(401).json({ error: "Unauthorized" });
    if (!zoneId) return res.status(400).json({ error: "Invalid zone id" });

    // ownership check
    const zone = await db.get(
      `
      SELECT z.id
      FROM zones z
      JOIN locations l ON l.id = z.location_id
      WHERE z.id=? AND l.user_email=?
      `,
      zoneId,
      email
    );
    if (!zone) return res.status(403).json({ error: "Forbidden" });

    await db.run("DELETE FROM zone_rules WHERE zone_id=?", zoneId);

    return res.json({ ok: true });
  } catch (err) {
    console.error("Zone rule delete error:", err);
    return res.status(500).json({ error: "Failed to delete rule" });
  }
});

export default router;
