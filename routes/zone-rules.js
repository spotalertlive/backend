import express from "express";
const router = express.Router();

/*
  Rule per zone
  rule_type: known_only | unknown_only | mixed
*/

router.post("/", async (req, res) => {
  const db = req.app.get("db");
  const { zone_id, rule_type, alert_interval } = req.body;

  if (!zone_id || !rule_type) {
    return res.status(400).json({ error: "Missing rule data" });
  }

  await db.run(
    `INSERT INTO zone_rules (zone_id, rule_type, alert_interval)
     VALUES (?,?,?)`,
    zone_id,
    rule_type,
    alert_interval || 10
  );

  res.json({ ok: true });
});

router.get("/:zoneId", async (req, res) => {
  const db = req.app.get("db");
  const { zoneId } = req.params;

  const rule = await db.get(
    `SELECT * FROM zone_rules WHERE zone_id=?`,
    zoneId
  );

  res.json(rule || {});
});

export default router;
