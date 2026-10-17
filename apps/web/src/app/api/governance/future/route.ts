// GET /api/governance/future
//
// Returns the governance future pillars + closing thesis statement.

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { GOVERNANCE_PILLARS, CLOSING_THESIS, CLOSING_STATEMENT } from "@/lib/governance/governance-future";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  return okResponse({
    pillars: GOVERNANCE_PILLARS,
    closingThesis: CLOSING_THESIS,
    closingStatement: CLOSING_STATEMENT,
    totalPillars: GOVERNANCE_PILLARS.length,
  });
});
