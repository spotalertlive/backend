import express from "express";
const router = express.Router();

/*
  Cost + usage per property per month
*/

router.get("/summary", async (req, res) => {
  const db = req.app.get("db");
  const email = req.user.email;
  const month = new Date().toISOString().slice(0, 7);

  const rows = await db.all(
    `
    SELECT p.id as property_id,
           p.name,
           IFNULL(u.scans_used,0) as scans_used,
           IFNULL(u.cost,0) as cost
    FROM properties p
    LEFT JOIN usage_costs u
      ON u.property_id = p.id
     AND u.month = ?
     AND u.user_email = ?
    WHERE p.user_email = ?
    `,
    month,
    email,
    email
  );

  res.json({
    month,
    properties: rows
  });
});

export default router;
