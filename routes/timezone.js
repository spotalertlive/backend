import express from "express";
const router = express.Router();

let eventLogs = [];

// POST /api/timezone
router.post("/timezone", (req, res) => {
  try {
    const { timezone, email } = req.body;
    eventLogs.push({
      type: "timezone",
      timezone,
      email,
      timestamp: new Date().toISOString()
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error("timezone error:", err);
    return res.status(500).json({ error: "Failed to save timezone" });
  }
});

// POST /api/log-event
router.post("/log-event", (req, res) => {
  try {
    const { event, email } = req.body;
    eventLogs.push({
      type: "event",
      event,
      email,
      timestamp: new Date().toISOString()
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error("log-event error:", err);
    return res.status(500).json({ error: "Failed to log event" });
  }
});

export default router;
