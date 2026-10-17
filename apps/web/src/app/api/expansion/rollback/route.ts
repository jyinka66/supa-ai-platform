// GET /api/expansion/rollback
//
// Returns the rollback paths + retirement triggers for a region launch.

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { ROLLBACK_PATHS, RETIREMENT_TRIGGERS } from "@/lib/expansion/rollback-retirement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  return okResponse({
    rollbackPaths: ROLLBACK_PATHS,
    retirementTriggers: RETIREMENT_TRIGGERS,
    totalRollbacks: ROLLBACK_PATHS.length,
    totalRetirementTriggers: RETIREMENT_TRIGGERS.length,
  });
});
