// GET /api/expansion/acceptance
//
// Returns the regional expansion acceptance criteria + readiness summary.

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { verifyAcceptanceCriteria, getPlaybookReadinessSummary, ACCEPTANCE_CRITERIA } from "@/lib/expansion/acceptance-criteria";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  return okResponse({
    criteria: ACCEPTANCE_CRITERIA,
    verification: verifyAcceptanceCriteria(),
    readinessSummary: getPlaybookReadinessSummary(),
  });
});
