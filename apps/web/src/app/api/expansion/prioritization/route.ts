// POST /api/expansion/prioritization
//
// Computes a priority score for a region (0-100) using the 7 priority factors
// (demand, market size, revenue, readiness, cost, strategic, risk) and the
// active score weights.
//
// Body:
//   regionCode: string
//
// Returns: { score, factors, weights, queueRank }
//
// Auth: admin read_only.

import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody } from "@/lib/api/route-helpers";
import {
  computePriorityScore,
  getPriorityQueue,
  getActiveScoreWeights,
  PRIORITY_FACTORS,
} from "@/lib/expansion/stage-prioritization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  regionCode: z.string().min(2).max(8).regex(/^[A-Z_-]+$/i),
});

export const POST = adminOnly("read_only", async (req, ctx) => {
  const body = await parseJsonBody(req, BodySchema);

  const [score, queue, weights] = await Promise.all([
    computePriorityScore(body.regionCode),
    getPriorityQueue(),
    getActiveScoreWeights(),
  ]);

  // Find the region's rank in the priority queue.
  const rank = queue.findIndex((q) => q.regionCode === body.regionCode);

  return okResponse({
    regionCode: body.regionCode,
    score,
    factors: PRIORITY_FACTORS,
    weights,
    queueRank: rank >= 0 ? rank + 1 : null,
    queueLength: queue.length,
    scoredBy: ctx.admin!.adminId,
    scoredAt: new Date().toISOString(),
  });
});
