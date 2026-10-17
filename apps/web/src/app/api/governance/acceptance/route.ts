// GET /api/governance/acceptance
//
// Returns the governance acceptance criteria + launch readiness summary.

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { verifyAcceptanceCriteria, getLaunchReadinessSummary, ACCEPTANCE_CRITERIA, getAcceptanceCriterion } from "@/lib/governance/acceptance-criteria";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  const url = new URL(req.url);
  const criterionId = url.searchParams.get("id");

  return okResponse({
    criteria: ACCEPTANCE_CRITERIA,
    verification: verifyAcceptanceCriteria(),
    readinessSummary: getLaunchReadinessSummary(),
    sampleCriterion: criterionId ? getAcceptanceCriterion(criterionId) : null,
  });
});
