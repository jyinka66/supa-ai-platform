// GET /api/expansion/risks
//
// Returns the regional expansion risks + mitigations.

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { RISKS_AND_MITIGATIONS } from "@/lib/expansion/risks-mitigations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  return okResponse({
    risks: RISKS_AND_MITIGATIONS,
    total: RISKS_AND_MITIGATIONS.length,
  });
});
