// POST /api/expansion/preparation
//
// Runs a single preparation workstream (one of 9: language, content, legal,
// tax, payments, infrastructure, support, marketing, cultural) for a region.
//
// Body:
//   regionCode: string
//   workstream: WorkstreamId enum
//
// Returns: { result, workstreamSpec }
//
// Auth: admin senior — workstreams mutate regional state.

import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody } from "@/lib/api/route-helpers";
import {
  runWorkstream,
  runAllPreparationWorkstreams,
  isPreparationComplete,
  getWorkstream,
  PREPARATION_WORKSTREAMS,
  type WorkstreamId,
} from "@/lib/expansion/stage-preparation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  regionCode: z.string().min(2).max(8).regex(/^[A-Z_-]+$/i),
  workstream: z.enum([
    "language", "content", "legal", "tax", "payments",
    "infrastructure", "support", "marketing", "cultural",
  ]) as z.ZodType<WorkstreamId>,
  runAll: z.boolean().optional(),
});

export const POST = adminOnly("senior", async (req, ctx) => {
  const body = await parseJsonBody(req, BodySchema);

  if (body.runAll) {
    const results = await runAllPreparationWorkstreams(body.regionCode);
    const allComplete = await isPreparationComplete(body.regionCode);
    return okResponse({
      regionCode: body.regionCode,
      results,
      allComplete,
      totalWorkstreams: PREPARATION_WORKSTREAMS.length,
      triggeredBy: ctx.admin!.adminId,
      triggeredAt: new Date().toISOString(),
    });
  }

  const result = await runWorkstream(body.workstream, body.regionCode);
  const spec = getWorkstream(body.workstream);

  return okResponse({
    regionCode: body.regionCode,
    workstream: body.workstream,
    result,
    workstreamSpec: spec,
    triggeredBy: ctx.admin!.adminId,
    triggeredAt: new Date().toISOString(),
  });
});
