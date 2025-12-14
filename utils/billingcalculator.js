// backend/utils/billingCalculator.js

export function calculateUsage({ plan, alerts }) {
  const scansUsed = alerts.length;

  const scanLimit = plan.scan_limit ?? 0;
  const camerasAllowed = plan.cameras ?? 0;

  const scansRemaining =
    scanLimit === 0 ? "unlimited" : Math.max(scanLimit - scansUsed, 0);

  let totalCost = 0;
  for (const a of alerts) {
    totalCost += Number(a.cost || 0);
  }

  return {
    plan: plan.name,
    scans_used: scansUsed,
    scans_limit: scanLimit,
    scans_remaining: scansRemaining,
    cameras_allowed: camerasAllowed,
    total_cost_usd: Number(totalCost.toFixed(4)),
  };
}
