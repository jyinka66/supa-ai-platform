// GET /api/governance/decision-domains
//
// Returns the 8 governance decision domains + their implementation status.

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { verifyDecisionDomains, getDomainSummary, DECISION_DOMAINS } from "@/lib/governance/decision-domains";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  return okResponse({
    domains: DECISION_DOMAINS,
    verification: verifyDecisionDomains(),
    summary: getDomainSummary(),
  });
});
