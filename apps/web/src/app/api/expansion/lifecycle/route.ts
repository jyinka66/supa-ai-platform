// GET /api/expansion/lifecycle
//
// Returns the 9-stage region lifecycle: detected → evaluating → prioritized
// → preparing → verification → soft_launch → public_launch → monitoring →
// optimization. Plus the legal transitions between stages.

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { REGION_STAGES, LIFECYCLE_TRANSITIONS } from "@/lib/expansion/region-lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  return okResponse({
    stages: REGION_STAGES,
    transitions: LIFECYCLE_TRANSITIONS,
    totalStages: REGION_STAGES.length,
  });
});
