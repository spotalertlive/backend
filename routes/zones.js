import express from "express";
const router = express.Router();

/*
  Zones belong to a property
*/

router.post("/", async (req, res) => {
  const db = req.app.get("db");
  const { property_id, name, active_hours } = req.body;

  if (!property_id || !name) {
    return res.status(400).json({ error: "Missing fields" });
  }

  await db.run(
    `INSERT INTO zones (property_id, name, active_hours)
     VALUES (?,?,?)`,
    property_id,
    name,
    active_hours ? JSON.stringify(active_hours) : null
  );

  res.json({ ok: true });
});

router.get("/:propertyId", async (req, res) => {
  const db = req.app.get("db");
  const { propertyId } = req.params;

  const zones = await db.all(
    `SELECT * FROM zones WHERE property_id=?`,
    propertyId
  );

  res.json(zones);
});

export default router;
