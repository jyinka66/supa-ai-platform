// GET /api/expansion/governance-integration
//
// Returns the governance integrations (which expansion decisions are
// governance-gated) + the verification status.

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { verifyGovernanceIntegration, GOVERNANCE_INTEGRATIONS, isDecisionGoverned } from "@/lib/expansion/governance-integration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  const url = new URL(req.url);
  const decisionType = url.searchParams.get("decisionType");

  return okResponse({
    integrations: GOVERNANCE_INTEGRATIONS,
    verification: verifyGovernanceIntegration(),
    sampleDecisionCheck: decisionType
      ? { decisionType, isGoverned: isDecisionGoverned(decisionType) }
      : null,
  });
});
