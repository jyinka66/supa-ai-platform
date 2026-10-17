// GET /api/governance/regional-expansion/check
// POST /api/governance/regional-expansion/check
//
// GET: returns the expansion thresholds + compliance gates.
// POST: checks whether a region meets the threshold + compliance gates.

import { NextRequest } from "next/server";
import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody } from "@/lib/api/route-helpers";
import {
  EXPANSION_THRESHOLDS,
  checkThreshold,
  type ExpansionKind,
} from "@/lib/governance/regional-vertical-expansion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  return okResponse({
    thresholds: EXPANSION_THRESHOLDS,
    totalKinds: Object.keys(EXPANSION_THRESHOLDS).length,
  });
});

const BodySchema = z.object({
  kind: z.enum(["region", "language", "vertical", "jurisdiction"]) as z.ZodType<ExpansionKind>,
  currentUsage: z.number().int().min(0),
});

export const POST = adminOnly("read_only", async (req, ctx) => {
  const body = await parseJsonBody(req, BodySchema);
  const result = checkThreshold(body.kind, body.currentUsage);
  return okResponse({
    ...body,
    result,
  });
});
