import express from "express";
const router = express.Router();

/*
  ZONE RULES

  rule_type:
    - known_only     → alert only if UNKNOWN appears
    - unknown_only   → alert only if UNKNOWN appears
    - mixed          → alert for both

  alert_interval:
    minutes before alerting again for SAME person
*/

/* =========================
   CREATE / UPDATE RULE
========================= */
router.post("/", async (req, res) => {
  try {
    const db = req.app.get("db");

    const zoneId = Number(req.body.zone_id);
    const ruleType = req.body.rule_type;
    const alertInterval = Number(req.body.alert_interval || 10);

    if (!zoneId || !ruleType) {
      return res.status(400).json({ error: "Missing rule data" });
    }

    // only allowed values
    const allowed = ["known_only", "unknown_only", "mixed"];
    if (!allowed.includes(ruleType)) {
      return res.status(400).json({ error: "Invalid rule type" });
    }

    // one rule per zone (UPSERT)
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

    return res.json({ ok: true });
  } catch (err) {
    console.error("Zone rule save error:", err);
    return res.status(500).json({ error: "Failed to save zone rule" });
  }
});

/* =========================
   GET RULE BY ZONE
========================= */
router.get("/:zoneId", async (req, res) => {
  try {
    const db = req.app.get("db");
    const zoneId = Number(req.params.zoneId);

    if (!zoneId) {
      return res.status(400).json({ error: "Invalid zone id" });
    }

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
   DELETE RULE (optional)
========================= */
router.delete("/:zoneId", async (req, res) => {
  try {
    const db = req.app.get("db");
    const zoneId = Number(req.params.zoneId);

    if (!zoneId) {
      return res.status(400).json({ error: "Invalid zone id" });
    }

    await db.run(
      "DELETE FROM zone_rules WHERE zone_id=?",
      zoneId
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("Zone rule delete error:", err);
    return res.status(500).json({ error: "Failed to delete rule" });
  }
});

export default router;
