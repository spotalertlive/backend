// backend/services/detection.js
// Central detection + alert pipeline (USED by CCTV + manual trigger)
// S3 ONLY for images — no local storage
// SAFE: does not crash if AWS is temporarily unavailable

import crypto from "crypto";
import {
  SearchFacesByImageCommand
} from "@aws-sdk/client-rekognition";

/**
 * Core detection pipeline
 * @param {Object} params
 */
export async function processDetection({
  app,
  userEmail,
  imageBuffer,
  zoneId = null,
  cameraId = null,
  channel = "email"
}) {
  const db = app.get("db");
  const rekognition = app.get("rekognition");
  const s3 = app.get("s3");

  const email = String(userEmail || "").toLowerCase();
  if (!email) return { ok: false, error: "Missing user email" };

  const S3_BUCKET =
    process.env.S3_BUCKET ||
    process.env.S3_BUCKET_NAME ||
    process.env.S3_BUCKET_ALERTS;

  const COLLECTION_ID = process.env.REKOG_COLLECTION_ID;
  if (!S3_BUCKET || !COLLECTION_ID) {
    return { ok: false, error: "AWS not configured" };
  }

  // --------------------------------------------------
  // 1️⃣ Zone cooldown (UNKNOWN only)
  // --------------------------------------------------
  if (zoneId) {
    const rule = await db.get(
      "SELECT alert_interval FROM zone_rules WHERE zone_id=?",
      zoneId
    );

    const minutes =
      Number(rule?.alert_interval) ||
      Number(process.env.UNKNOWN_ALERT_COOLDOWN_MINUTES) ||
      5;

    const since = new Date(Date.now() - minutes * 60000).toISOString();

    const recent = await db.get(
      `
      SELECT id FROM alerts
      WHERE zone_id=? AND type='unknown' AND timestamp >= ?
      ORDER BY timestamp DESC
      LIMIT 1
      `,
      zoneId,
      since
    );

    if (recent) {
      return {
        ok: true,
        skipped: true,
        reason: "cooldown",
        zone_id: zoneId
      };
    }
  }

  // --------------------------------------------------
  // 2️⃣ Rekognition face search
  // --------------------------------------------------
  let matches = [];
  try {
    const r = await rekognition.send(
      new SearchFacesByImageCommand({
        CollectionId: COLLECTION_ID,
        Image: { Bytes: imageBuffer }
      })
    );
    matches = r.FaceMatches || [];
  } catch (e) {
    console.error("Rekognition search failed:", e);
    matches = [];
  }

  const isKnown = matches.length > 0;

  // --------------------------------------------------
  // 3️⃣ Zone rule allow/block
  // --------------------------------------------------
  if (zoneId) {
    const rule = await db.get(
      "SELECT rule_type FROM zone_rules WHERE zone_id=?",
      zoneId
    );

    const type = rule?.rule_type || "mixed";
    if (type === "known_only" && !isKnown)
      return { ok: true, skipped: true, reason: "zone_rule" };
    if (type === "unknown_only" && isKnown)
      return { ok: true, skipped: true, reason: "zone_rule" };
  }

  // --------------------------------------------------
  // 4️⃣ Cost (zone aware)
  // --------------------------------------------------
  let cost = 0.001;
  if (zoneId) {
    const z = await db.get(
      "SELECT cost_per_scan FROM zones WHERE id=?",
      zoneId
    );
    if (z?.cost_per_scan != null) cost = Number(z.cost_per_scan);
  }

  // --------------------------------------------------
  // 5️⃣ Store snapshot to S3
  // --------------------------------------------------
  const key = `alerts/${email}/${Date.now()}_${crypto
    .randomBytes(6)
    .toString("hex")}.jpg`;

  try {
    await s3.send({
      Bucket: S3_BUCKET,
      Key: key,
      Body: imageBuffer,
      ContentType: "image/jpeg"
    });
  } catch (e) {
    console.error("S3 upload failed:", e);
    return { ok: false, error: "S3 upload failed" };
  }

  // --------------------------------------------------
  // 6️⃣ Insert alert record
  // --------------------------------------------------
  const insert = await db.run(
    `
    INSERT INTO alerts
    (user_email,type,image_key,channel,cost,zone_id,camera_id,timestamp)
    VALUES (?,?,?,?,?,?,?,?)
    `,
    email,
    isKnown ? "known" : "unknown",
    key,
    channel,
    cost,
    zoneId,
    cameraId,
    new Date().toISOString()
  );

  const alertId = insert?.lastID;

  return {
    ok: true,
    alert_id: alertId,
    type: isKnown ? "known" : "unknown",
    faces: matches,
    cost,
    zone_id: zoneId,
    camera_id: cameraId,
    image_key: key
  };
}
