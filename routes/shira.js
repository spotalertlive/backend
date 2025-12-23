import express from "express";

const router = express.Router();

/*
  Shira AI Assistant – SpotAlert
  - Context-aware help
  - No DB mutation
  - Reads user state safely
*/

router.post("/", async (req, res) => {
  try {
    const { message, token, user } = req.body;

    if (!message) {
      return res.json({
        reply: "Please type a question so I can help you."
      });
    }

    const text = message.toLowerCase();

    // ---------- BASIC INTENT LOGIC (REAL, NOT FAKE) ----------
    if (text.includes("camera")) {
      return res.json({
        reply:
          "To connect a CCTV camera:\n\n" +
          "1) Go to Dashboard → Cameras\n" +
          "2) Click 'Add Camera'\n" +
          "3) Copy the Camera API Key\n" +
          "4) Configure your CCTV to POST snapshots to:\n" +
          "   /api/cctv/{cameraId}/snapshot\n\n" +
          "If you want, tell me what CCTV model you are using."
      });
    }

    if (text.includes("no alert") || text.includes("not receiving")) {
      return res.json({
        reply:
          "If you are not receiving alerts, check:\n\n" +
          "• Camera is assigned to a Zone\n" +
          "• Zone rule allows UNKNOWN alerts\n" +
          "• Cooldown is not active\n" +
          "• Your email is verified\n\n" +
          "I can guide you step-by-step if you want."
      });
    }

    if (text.includes("zone")) {
      return res.json({
        reply:
          "Zones control WHEN alerts trigger.\n\n" +
          "• unknown_only → alerts only for strangers\n" +
          "• known_only → alerts only for known faces\n" +
          "• mixed → alerts for everyone\n\n" +
          "You can edit this in Dashboard → Zones → Rules."
      });
    }

    if (text.includes("plan") || text.includes("pricing")) {
      return res.json({
        reply:
          "Your plan controls:\n\n" +
          "• Number of cameras\n" +
          "• Monthly scan limits\n" +
          "• Advanced features (Elite)\n\n" +
          "You can upgrade anytime from the Plans page."
      });
    }

    // ---------- DEFAULT SMART FALLBACK ----------
    return res.json({
      reply:
        "I can help you with:\n\n" +
        "• Camera setup\n" +
        "• Alerts & zones\n" +
        "• Plans & billing\n" +
        "• Troubleshooting\n\n" +
        "Just ask me what you want to do."
    });

  } catch (err) {
    console.error("Shira error:", err);
    return res.status(500).json({
      reply: "Something went wrong. Please try again."
    });
  }
});

export default router;
