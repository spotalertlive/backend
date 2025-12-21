import express from "express";
const router = express.Router();

/*
  Properties = House, Cottage, Plant, etc
*/

router.post("/", async (req, res) => {
  const db = req.app.get("db");
  const { name, location } = req.body;
  const email = req.user.email;

  if (!name) {
    return res.status(400).json({ error: "Property name required" });
  }

  await db.run(
    `INSERT INTO properties (user_email, name, location)
     VALUES (?,?,?)`,
    email,
    name,
    location || null
  );

  res.json({ ok: true });
});

router.get("/", async (req, res) => {
  const db = req.app.get("db");
  const email = req.user.email;

  const rows = await db.all(
    `SELECT * FROM properties WHERE user_email=? ORDER BY created_at DESC`,
    email
  );

  res.json(rows);
});

export default router;
