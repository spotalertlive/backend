import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";

// AWS
import {
  RekognitionClient,
  SearchFacesByImageCommand
} from "@aws-sdk/client-rekognition";

import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

// Stripe
import Stripe from "stripe";

dotenv.config();
const app = express();

app.use(cors());
app.use(express.json());

// ===== AWS CLIENTS =====
const rekognition = new RekognitionClient({ region: process.env.AWS_REGION });
const ses = new SESClient({ region: process.env.AWS_REGION });

// ===== STRIPE =====
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ===== FILE UPLOADS =====
const upload = multer({ storage: multer.memoryStorage() });

// ===== HEALTH CHECK =====
app.get("/", (req, res) => {
  res.json({ status: "SpotAlert backend running" });
});

// ===== FACE SEARCH =====
app.post("/upload", upload.single("image"), async (req, res) => {
  try {
    const params = {
      CollectionId: process.env.REKOG_COLLECTION_ID,
      Image: { Bytes: req.file.buffer }
    };

    const response = await rekognition.send(
      new SearchFacesByImageCommand(params)
    );

    res.json(response);
  } catch (error) {
    console.error("Rekognition Error:", error);
    res.status(500).json({ error: "Face search failed" });
  }
});

// ===== EMAIL ALERT =====
app.post("/alert-email", async (req, res) => {
  try {
    const { to, subject, message } = req.body;

    const emailParams = {
      Source: process.env.SES_FROM_EMAIL,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject },
        Body: { Text: { Data: message } }
      }
    };

    await ses.send(new SendEmailCommand(emailParams));

    res.json({ status: "Email sent" });
  } catch (error) {
    console.error("SES Error:", error);
    res.status(500).json({ error: "Email failed" });
  }
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SpotAlert backend running on port ${PORT}`);
});
