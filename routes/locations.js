import express from "express";
const router = express.Router();

/*
  LOCATIONS = properties
  Example:
  - House
  - Cottage
  - Plant / Warehouse

  One user (email) can own multiple locations
*/

/* =========================
   CREATE LOCATION
========================= */
router.post("/", async (req, res) => {
  try {
    const db = req.app.get("db");

    const userEmail = (req.body.user_email || "").toLowerCase();
    const name = (req.body.name || "").trim();
    const address = req.body.address || null;

    if (!userEmail || !name) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    await db.run(
      `INSERT INTO locations (user_email, name, address)
       VALUES (?,?,?)`,
      userEmail,
      name,
      address
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("Create location error:", err);
    return res.status(500).json({ error: "Failed to create location" });
  }
});

/* =========================
   GET LOCATIONS BY USER
========================= */
router.get("/user/:email", async (req, res) => {
  try {
    const db = req.app.get("db");
    const email = (req.params.email || "").toLowerCase();

    if (!email) {
      return res.status(400).json({ error: "Invalid user email" });
    }

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
   UPDATE LOCATION
========================= */
router.put("/:locationId", async (req, res) => {
  try {
    const db = req.app.get("db");
    const locationId = Number(req.params.locationId);

    if (!locationId) {
      return res.status(400).json({ error: "Invalid location id" });
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
   DELETE LOCATION
   (zones + cameras should be handled by UI before delete)
========================= */
router.delete("/:locationId", async (req, res) => {
  try {
    const db = req.app.get("db");
    const locationId = Number(req.params.locationId);

    if (!locationId) {
      return res.status(400).json({ error: "Invalid location id" });
    }

    await db.run(
      "DELETE FROM locations WHERE id=?",
      locationId
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("Delete location error:", err);
    return res.status(500).json({ error: "Failed to delete location" });
  }
});

export default router;
