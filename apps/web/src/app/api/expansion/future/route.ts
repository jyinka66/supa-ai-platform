// GET /api/expansion/future
//
// Returns the expansion pillars (long-term vision) + closing thesis
// statements.

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { EXPANSION_PILLARS, CLOSING_THESIS, CLOSING_STATEMENT } from "@/lib/expansion/expansion-future";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  return okResponse({
    pillars: EXPANSION_PILLARS,
    closingThesis: CLOSING_THESIS,
    closingStatement: CLOSING_STATEMENT,
    totalPillars: EXPANSION_PILLARS.length,
  });
});
