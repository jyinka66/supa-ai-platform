// GET /api/governance/reputation-trust
//
// Returns the reputation dimensions + trust tier thresholds.

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { TRUST_THRESHOLDS, getTrustTier, type ReputationDimension } from "@/lib/governance/reputation-trust";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  const url = new URL(req.url);
  const score = url.searchParams.get("score");

  return okResponse({
    thresholds: TRUST_THRESHOLDS,
    sampleTier: score ? getTrustTier(parseInt(score, 10)) : null,
  });
});
