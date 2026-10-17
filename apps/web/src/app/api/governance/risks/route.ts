// GET /api/governance/risks
//
// Returns the governance risks + mitigations catalog.

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { RISKS_AND_MITIGATIONS } from "@/lib/governance/risks-mitigations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  return okResponse({
    risks: RISKS_AND_MITIGATIONS,
    total: RISKS_AND_MITIGATIONS.length,
  });
});
