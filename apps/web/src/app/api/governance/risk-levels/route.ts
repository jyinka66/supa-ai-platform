// GET /api/governance/risk-levels
//
// Returns the 5 risk levels + their approval flows, logging levels, and
// rate-limit tiers.

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { RISK_LEVELS } from "@/lib/governance/risk-levels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  return okResponse({
    riskLevels: RISK_LEVELS,
    total: Object.keys(RISK_LEVELS).length,
  });
});
