// POST /api/expansion/detection
//
// Detects demand signals for a region. Runs the detection cycle that pulls
// demand signals (search volume, signup waitlist, support tickets, social
// mentions, partner requests) over a window, then queues the region for
// evaluation if it crosses the threshold.
//
// Body:
//   regionCode: string (e.g. "NG", "KE", "ZA")
//   windowDays?: number (default 90)
//   regionType?: string (e.g. "country", "state", "metro")
//
// Returns: { bundle, queueEntry }
//
// Auth: admin senior — detection triggers downstream evaluation.

import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody } from "@/lib/api/route-helpers";
import { detectDemandSignals, queueForEvaluation } from "@/lib/expansion/stage-detection";
import { DEMAND_SIGNAL_TYPES, DETECTION_THRESHOLDS } from "@/lib/expansion/stage-detection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  regionCode: z.string().min(2).max(8).regex(/^[A-Z_-]+$/i),
  windowDays: z.number().int().min(7).max(365).optional(),
  regionType: z.string().max(50).optional(),
});

export const POST = adminOnly("senior", async (req, ctx) => {
  const body = await parseJsonBody(req, BodySchema);

  const bundle = await detectDemandSignals({
    regionCode: body.regionCode,
    windowDays: body.windowDays,
    regionType: body.regionType,
  });

  const queueEntry = await queueForEvaluation(bundle);

  return okResponse({
    bundle,
    queueEntry,
    signalTypes: DEMAND_SIGNAL_TYPES,
    thresholds: DETECTION_THRESHOLDS,
    triggeredBy: ctx.admin!.adminId,
    triggeredAt: new Date().toISOString(),
  });
});
