// GET /api/expansion/autonomy
//
// Returns the per-stage autonomy levels (fully autonomous | supervised |
// human-in-the-loop | human-only) and the human checkpoint list.

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { STAGE_AUTONOMY, HUMAN_CHECKPOINTS } from "@/lib/expansion/autonomous-execution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  return okResponse({
    stageAutonomy: STAGE_AUTONOMY,
    humanCheckpoints: HUMAN_CHECKPOINTS,
    totalCheckpoints: HUMAN_CHECKPOINTS.length,
  });
});
