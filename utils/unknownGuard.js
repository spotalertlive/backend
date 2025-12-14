// backend/utils/unknownGuard.js

export function isUnknownFace(rekognitionResult) {
  /**
   * rekognitionResult should include FaceMatches
   * If FaceMatches is empty or undefined → UNKNOWN
   */

  if (!rekognitionResult) return true;

  const matches = rekognitionResult.FaceMatches || [];

  return matches.length === 0;
}
