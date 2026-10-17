// GET /api/expansion/optimization?regionCode=NG
// POST /api/expansion/optimization
//
// GET: lists optimization opportunities for a region (pricing, packaging,
// onboarding, support, growth, retention).
// POST: implements an optimization (records the action + audit).

import { NextRequest } from "next/server";
import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody } from "@/lib/api/route-helpers";
import {
  identifyOptimizationOpportunities,
  implementOptimization,
  OPTIMIZATION_AREAS,
} from "@/lib/expansion/stage-optimization";
import { ApiError } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  const url = new URL(req.url);
  const regionCode = url.searchParams.get("regionCode");
  if (!regionCode) {
    return okResponse({
      areas: OPTIMIZATION_AREAS,
      message: "Pass ?regionCode=NG to identify concrete opportunities.",
    });
  }
  const opportunities = await identifyOptimizationOpportunities(regionCode);
  return okResponse({
    regionCode,
    opportunities,
    areas: OPTIMIZATION_AREAS,
    totalOpportunities: opportunities.length,
  });
});

const BodySchema = z.object({
  regionCode: z.string().min(2).max(8).regex(/^[A-Z_-]+$/i),
  area: z.enum([
    "pricing", "payment_methods", "content", "support",
    "product", "marketing", "localization", "compliance",
  ]),
  action: z.string().min(5).max(500),
  reason: z.string().min(10).max(2000),
});

export const POST = adminOnly("senior", async (req, ctx) => {
  const body = await parseJsonBody(req, BodySchema);
  await implementOptimization({
    regionCode: body.regionCode,
    area: body.area,
    action: body.action,
    implementedBy: ctx.admin!.adminId,
    reason: body.reason,
  });
  return okResponse({
    regionCode: body.regionCode,
    area: body.area,
    action: body.action,
    implementedAt: new Date().toISOString(),
    implementedBy: ctx.admin!.adminId,
  });
});
