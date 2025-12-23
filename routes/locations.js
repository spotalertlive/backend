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
  LOCATIONS = properties
  Example:
  - House
  - Cottage
  - Plant / Warehouse

  One user (JWT email) can own multiple locations
*/

/* =========================
   CREATE LOCATION
   POST /api/locations
========================= */
router.post("/", requireAuth, async (req, res) => {
  try {
    const db = req.app.get("db");

    const userEmail = req.user.email.toLowerCase(); // 🔒 JWT ONLY
    const name = (req.body.name || "").trim();
    const address = req.body.address || null;

    if (!name) {
      return res.status(400).json({ error: "Location name required" });
    }

    const result = await db.run(
      `INSERT INTO locations (user_email, name, address)
       VALUES (?,?,?)`,
      userEmail,
      name,
      address
    );

    return res.json({ ok: true, id: result.lastID });
  } catch (err) {
    console.error("Create location error:", err);
    return res.status(500).json({ error: "Failed to create location" });
  }
});

/* =========================
   GET LOCATIONS (OWNER)
   GET /api/locations
========================= */
router.get("/", requireAuth, async (req, res) => {
  try {
    const db = req.app.get("db");
    const email = req.user.email.toLowerCase();

    const locations = await db.all(
      `SELECT id, name, address, created_at
       FROM locations
       WHERE user_email=?
       ORDER BY created_at ASC`,
      email
    );

    return res.json(locations);
  } catch (err) {
    console.error("Get locations error:", err);
    return res.status(500).json({ error: "Failed to load locations" });
  }
});

/* =========================
   UPDATE LOCATION (OWNER)
   PUT /api/locations/:locationId
========================= */
router.put("/:locationId", requireAuth, async (req, res) => {
  try {
    const db = req.app.get("db");
    const email = req.user.email.toLowerCase();
    const locationId = Number(req.params.locationId);

    if (!locationId) {
      return res.status(400).json({ error: "Invalid location id" });
    }

    // ownership check
    const loc = await db.get(
      `SELECT id FROM locations WHERE id=? AND user_email=?`,
      locationId,
      email
    );
    if (!loc) {
      return res.status(404).json({ error: "Location not found" });
    }

    const fields = [];
    const values = [];

    if (req.body.name) {
      fields.push("name=?");
      values.push(req.body.name.trim());
    }

    if (req.body.address !== undefined) {
      fields.push("address=?");
      values.push(req.body.address);
    }

    if (!fields.length) {
      return res.status(400).json({ error: "Nothing to update" });
    }

    values.push(locationId);

    await db.run(
      `UPDATE locations SET ${fields.join(", ")} WHERE id=?`,
      values
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("Update location error:", err);
    return res.status(500).json({ error: "Failed to update location" });
  }
});

/* =========================
   DELETE LOCATION (OWNER)
   DELETE /api/locations/:locationId
========================= */
router.delete("/:locationId", requireAuth, async (req, res) => {
  try {
    const db = req.app.get("db");
    const email = req.user.email.toLowerCase();
    const locationId = Number(req.params.locationId);

    if (!locationId) {
      return res.status(400).json({ error: "Invalid location id" });
    }

    // ownership check
    const loc = await db.get(
      `SELECT id FROM locations WHERE id=? AND user_email=?`,
      locationId,
      email
    );
    if (!loc) {
      return res.status(404).json({ error: "Location not found" });
    }

    // Optional cascade cleanup
    await db.run("DELETE FROM zones WHERE location_id=?", locationId);
    await db.run("DELETE FROM locations WHERE id=?", locationId);

    return res.json({ ok: true });
  } catch (err) {
    console.error("Delete location error:", err);
    return res.status(500).json({ error: "Failed to delete location" });
  }
});

export default router;
