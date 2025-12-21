import express from "express";
const router = express.Router();

/*
  Zones belong to a LOCATION (house / cottage / plant)
  Zones can have:
  - active time rules
  - cost per scan
*/

/* =========================
   CREATE ZONE
========================= */
router.post("/", async (req, res) => {
  try {
    const db = req.app.get("db");

    const locationId = Number(req.body.location_id);
    const name = (req.body.name || "").trim();
    const activeHours = req.body.active_hours || null; 
    const costPerScan =
      req.body.cost_per_scan != null
        ? Number(req.body.cost_per_scan)
        : 0.001;

    if (!locationId || !name) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    await db.run(
      `INSERT INTO zones (location_id, name, cost_per_scan, active_hours)
       VALUES (?,?,?,?)`,
      locationId,
      name,
      costPerScan,
      activeHours ? JSON.stringify(activeHours) : null
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("Create zone error:", err);
    return res.status(500).json({ error: "Failed to create zone" });
  }
});

/* =========================
   GET ZONES BY LOCATION
========================= */
router.get("/location/:locationId", async (req, res) => {
  try {
    const db = req.app.get("db");
    const locationId = Number(req.params.locationId);

    if (!locationId) {
      return res.status(400).json({ error: "Invalid location id" });
    }

    const zones = await db.all(
      `SELECT id, name, cost_per_scan, active_hours, created_at
       FROM zones
       WHERE location_id=?
       ORDER BY created_at ASC`,
      locationId
    );

    const parsed = zones.map((z) => ({
      ...z,
      active_hours: z.active_hours
        ? JSON.parse(z.active_hours)
        : null
    }));

    return res.json(parsed);
  } catch (err) {
    console.error("Get zones error:", err);
    return res.status(500).json({ error: "Failed to load zones" });
  }
});

/* =========================
   UPDATE ZONE
========================= */
router.put("/:zoneId", async (req, res) => {
  try {
    const db = req.app.get("db");
    const zoneId = Number(req.params.zoneId);

    if (!zoneId) {
      return res.status(400).json({ error: "Invalid zone id" });
    }

    const fields = [];
    const values = [];

    if (req.body.name) {
      fields.push("name=?");
      values.push(req.body.name.trim());
    }

    if (req.body.cost_per_scan != null) {
      fields.push("cost_per_scan=?");
      values.push(Number(req.body.cost_per_scan));
    }

    if (req.body.active_hours !== undefined) {
      fields.push("active_hours=?");
      values.push(
        req.body.active_hours
          ? JSON.stringify(req.body.active_hours)
          : null
      );
    }

    if (!fields.length) {
      return res.status(400).json({ error: "Nothing to update" });
    }

    values.push(zoneId);

    await db.run(
      `UPDATE zones SET ${fields.join(", ")} WHERE id=?`,
      values
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("Update zone error:", err);
    return res.status(500).json({ error: "Failed to update zone" });
  }
});

/* =========================
   DELETE ZONE
========================= */
router.delete("/:zoneId", async (req, res) => {
  try {
    const db = req.app.get("db");
    const zoneId = Number(req.params.zoneId);

    if (!zoneId) {
      return res.status(400).json({ error: "Invalid zone id" });
    }

    await db.run(
      "DELETE FROM zones WHERE id=?",
      zoneId
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("Delete zone error:", err);
    return res.status(500).json({ error: "Failed to delete zone" });
  }
});

export default router;
