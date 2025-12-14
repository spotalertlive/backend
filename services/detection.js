// services/detection.js
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { SearchFacesByImageCommand } from "@aws-sdk/client-rekognition";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

/**
 * ONE detection engine for ALL inputs:
 * - CCTV snapshots
 * - Manual upload (dashboard)
 * - Future mobile app
 */
export async function detectAndHandle({
  app,               // express app (req.app)
  imageBuffer,       // Buffer
  userEmail,         // string (required)
  source = "manual", // "cctv" | "manual" | "webhook"
  cameraId = null,   // optional
  meta = {}          // optional object
}) {
  if (!imageBuffer) throw new Error("Missing imageBuffer");
  if (!userEmail) throw new Error("Missing userEmail");

  const email = userEmail.toLowerCase().trim();

  const db = app.get("db");
  const rekognition = app.get("rekognition");
  const sesFromApp = app.get("ses"); // may be undefined in your current server.js

  if (!db) throw new Error("DB not ready (app.set('db', db) missing)");
  if (!rekognition) throw new Error("Rekognition not ready (app.set('rekognition', rekognition) missing)");

  // SES fallback (so this file works even before you wire app.set("ses", ses))
  const ses =
    sesFromApp ||
    new SESClient({
      region: process.env.AWS_REGION
    });

  // 1) Rekognition match
  const rekogRes = await rekognition.send(
    new SearchFacesByImageCommand({
      CollectionId: process.env.REKOG_COLLECTION_ID,
      Image: { Bytes: imageBuffer }
    })
  );

  const matches = rekogRes.FaceMatches || [];
  const isKnown = matches.length > 0;

  // 2) Save alert image locally (ONLY for unknown alerts)
  let savedPath = null;

  if (!isKnown) {
    const baseDir = path.resolve(process.cwd(), "uploads", "alerts", email);
    fs.mkdirSync(baseDir, { recursive: true });

    const fileName = `${Date.now()}_${crypto.randomBytes(6).toString("hex")}.jpg`;
    savedPath = path.join(baseDir, fileName);
    fs.writeFileSync(savedPath, imageBuffer);
  }

  // 3) Insert alert row
  // NOTE: keep alerts table unchanged; we insert image_key only for unknown
  const insert = await db.run(
    `INSERT INTO alerts (user_email,type,image_key,channel,cost)
     VALUES (?,?,?,?,?)`,
    email,
    isKnown ? "known" : "unknown",
    savedPath ? savedPath : null,
    "email",
    0.001
  );

  const alertId = insert?.lastID;

  // 4) Optional: link to alert_images table (if you add it)
  // Safe: will not crash if table doesn't exist yet.
  if (!isKnown && alertId && savedPath) {
    try {
      await db.run(
        `INSERT INTO alert_images (alert_id, image_path)
         VALUES (?,?)`,
        alertId,
        savedPath
      );
    } catch {
      // ignore until table exists
    }
  }

  // 5) Send email ONLY for unknown
  if (!isKnown && email) {
    try {
      await ses.send(
        new SendEmailCommand({
          Source: process.env.SES_FROM_EMAIL,
          Destination: { ToAddresses: [email] },
          Message: {
            Subject: { Data: process.env.ALERT_SUBJECT || "SpotAlert Alert" },
            Body: { Text: { Data: "🚨 Unknown person detected. Login to view the snapshot." } }
          }
        })
      );
    } catch (e) {
      // email failures must not break alerts
      console.error("SES send error:", e);
    }
  }

  return {
    ok: true,
    isKnown,
    matchesCount: matches.length,
    alertId: alertId || null,
    imageSaved: !!savedPath,
    source,
    cameraId,
    meta
  };
}
