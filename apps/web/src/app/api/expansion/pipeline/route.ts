// GET /api/expansion/pipeline
//
// Returns the 9-stage expansion pipeline: detection → evaluation →
// prioritization → preparation → verification → soft launch → public launch →
// monitoring → optimization. Includes the per-stage autonomy level + the
// human-checkpoint list.
//
// Auth: admin read_only.

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { PIPELINE_STAGES } from "@/lib/expansion/pipeline";
import { STAGE_AUTONOMY, HUMAN_CHECKPOINTS } from "@/lib/expansion/autonomous-execution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  return okResponse({
    stages: PIPELINE_STAGES,
    autonomyLevels: STAGE_AUTONOMY,
    humanCheckpoints: HUMAN_CHECKPOINTS,
    total: PIPELINE_STAGES.length,
  });
});
