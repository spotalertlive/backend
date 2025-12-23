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
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

/*
  Zones belong to a LOCATION (house / cottage / plant)
  Zones can have:
  - active time rules
  - cost per scan
*/

/* =========================
   CREATE ZONE
   POST /api/zones
========================= */
router.post("/", requireAuth, async (req, res) => {
  try {
    const db = req.app.get("db");
    const email = req.user.email.toLowerCase();

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

    // 🔒 Ownership check (location must belong to user)
    const location = await db.get(
      `SELECT id FROM locations WHERE id=? AND user_email=?`,
      locationId,
      email
    );

    if (!location) {
      return res.status(404).json({ error: "Location not found" });
    }

    const result = await db.run(
      `INSERT INTO zones (location_id, name, cost_per_scan, active_hours)
       VALUES (?,?,?,?)`,
      locationId,
      name,
      costPerScan,
      activeHours ? JSON.stringify(activeHours) : null
    );

    return res.json({ ok: true, id: result.lastID });
  } catch (err) {
    console.error("Create zone error:", err);
    return res.status(500).json({ error: "Failed to create zone" });
  }
});

/* =========================
   GET ZONES BY LOCATION (OWNER)
   GET /api/zones/location/:locationId
========================= */
router.get("/location/:locationId", requireAuth, async (req, res) => {
  try {
    const db = req.app.get("db");
    const email = req.user.email.toLowerCase();
    const locationId = Number(req.params.locationId);

    if (!locationId) {
      return res.status(400).json({ error: "Invalid location id" });
    }

    // 🔒 Ownership check
    const location = await db.get(
      `SELECT id FROM locations WHERE id=? AND user_email=?`,
      locationId,
      email
    );

    if (!location) {
      return res.status(404).json({ error: "Location not found" });
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
   UPDATE ZONE (OWNER)
   PUT /api/zones/:zoneId
========================= */
router.put("/:zoneId", requireAuth, async (req, res) => {
  try {
    const db = req.app.get("db");
    const email = req.user.email.toLowerCase();
    const zoneId = Number(req.params.zoneId);

    if (!zoneId) {
      return res.status(400).json({ error: "Invalid zone id" });
    }

    // 🔒 Ownership check via location
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
      return res.status(404).json({ error: "Zone not found" });
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
   DELETE ZONE (OWNER)
   DELETE /api/zones/:zoneId
========================= */
router.delete("/:zoneId", requireAuth, async (req, res) => {
  try {
    const db = req.app.get("db");
    const email = req.user.email.toLowerCase();
    const zoneId = Number(req.params.zoneId);

    if (!zoneId) {
      return res.status(400).json({ error: "Invalid zone id" });
    }

    // 🔒 Ownership check
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
      return res.status(404).json({ error: "Zone not found" });
    }

    await db.run("DELETE FROM zones WHERE id=?", zoneId);

    return res.json({ ok: true });
  } catch (err) {
    console.error("Delete zone error:", err);
    return res.status(500).json({ error: "Failed to delete zone" });
  }
});

export default router;
