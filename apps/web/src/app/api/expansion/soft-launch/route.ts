// POST /api/expansion/soft-launch
//
// Designs a soft launch (cohort size, duration, metrics, guardrails) for a
// region.
//
// Body:
//   regionCode: string
//   cohortSize?: number (default: derived from market population)
//   durationWeeks?: number (default: 4)
//
// Returns: { design, metrics, recommendation }
//
// Auth: admin senior.

import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody } from "@/lib/api/route-helpers";
import {
  designSoftLaunch,
  getSoftLaunchMetrics,
  produceSoftLaunchOutput,
  COHORT_SOURCES,
  SOFT_LAUNCH_METRICS,
} from "@/lib/expansion/stage-soft-launch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  regionCode: z.string().min(2).max(8).regex(/^[A-Z_-]+$/i),
  cohortSize: z.number().int().min(50).max(100_000).optional(),
  durationWeeks: z.number().int().min(1).max(26).optional(),
});

export const POST = adminOnly("senior", async (req, ctx) => {
  const body = await parseJsonBody(req, BodySchema);

  const design = await designSoftLaunch({
    regionCode: body.regionCode,
    cohortSize: body.cohortSize,
    durationWeeks: body.durationWeeks,
  });
  const metrics = await getSoftLaunchMetrics(body.regionCode);
  const output = await produceSoftLaunchOutput(body.regionCode);

  return okResponse({
    regionCode: body.regionCode,
    design,
    metrics,
    output,
    cohortSources: COHORT_SOURCES,
    metricSpecs: SOFT_LAUNCH_METRICS,
    triggeredBy: ctx.admin!.adminId,
    triggeredAt: new Date().toISOString(),
  });
});
