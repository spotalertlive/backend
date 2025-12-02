
import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import PDFDocument from "pdfkit";

// AWS
import { RekognitionClient, DetectFacesCommand, SearchFacesByImageCommand } from "@aws-sdk/client-rekognition";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

// Stripe
import Stripe from "stripe";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// ===== DATABASE =====
const db = await open({
  filename: "./spotalert.db",
  driver: sqlite3.Database
});

// ===== AWS CLIENTS =====
const rekognition = new RekognitionClient({ region: process.env.AWS_REGION });
const s3 = new S3Client({ region: process.env.AWS_REGION });
const ses = new SESClient({ region: process.env.AWS_REGION });

// ===== STRIPE =====
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ===== FILE UPLOADS =====
const upload = multer({ storage: multer.memoryStorage() });

// ===== TEST ROUTE =====
app.get("/", (req, res) => {
  res.json({ message: "SpotAlert backend running" });
});

// ===== FACE UPLOAD ROUTE =====
app.post("/upload", upload.single("image"), async (req, res) => {
  try {
    const imageBytes = req.file.buffer;

    const params = {
      CollectionId: process.env.REKOG_COLLECTION_ID,
      Image: { Bytes: imageBytes }
    };

    const result = await rekognition.send(new SearchFacesByImageCommand(params));
    res.json(result);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Face search failed" });
  }
});

// ===== SEND EMAIL ALERT =====
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

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Email failed" });
  }
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SpotAlert backend running on port ${PORT}`);
});
