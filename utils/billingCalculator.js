// backend/utils/billingCalculator.js

export function calculateUsage({ plan, alerts }) {
  // -------------------------
  // SAFETY
  // -------------------------
  const safeAlerts = Array.isArray(alerts) ? alerts : [];

  const planName = plan?.name || "Unknown";

  const scanLimit =
    typeof plan?.scan_limit === "number"
      ? plan.scan_limit
      : 0;

  const camerasAllowed =
    typeof plan?.cameras === "number"
      ? plan.cameras
      : 0;

  // -------------------------
  // SCANS
  // -------------------------
  const scansUsed = safeAlerts.length;

  const scansRemaining = Math.max(scanLimit - scansUsed, 0);

  // -------------------------
  // COST
  // -------------------------
  let totalCost = 0;

  for (const alert of safeAlerts) {
    const cost = Number(alert?.cost || 0);
    if (!Number.isNaN(cost)) {
      totalCost += cost;
    }
  }

  // -------------------------
  // FINAL OUTPUT
  // -------------------------
  return {
    plan: planName,
    scans_used: scansUsed,
    scans_limit: scanLimit,
    scans_remaining: scansRemaining,
    cameras_allowed: camerasAllowed,
    total_cost_usd: Number(totalCost.toFixed(4))
  };
}
