// POST /api/governance/circuit-breakers/[id]
//
// Trips (open) or resets (close) a specific circuit breaker.
//
// Body:
//   action: "trip" | "reset"
//   reason: string

import { NextRequest } from "next/server";
import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody } from "@/lib/api/route-helpers";
import { GOVERNANCE_BREAKERS } from "@/lib/governance/circuit-breakers";
import { ApiError } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  action: z.enum(["trip", "reset"]),
  reason: z.string().min(10).max(2000),
});

export const POST = adminOnly("senior", async (req, ctx) => {
  const id = (req as unknown as { params?: Record<string, string | undefined> }).params?.id;
  if (!id) throw new ApiError("not_found", 404, { param: "id" });

  const body = await parseJsonBody(req, BodySchema);
  const spec = GOVERNANCE_BREAKERS.find((b) => b.type === id);
  if (!spec) throw new ApiError("not_found", 404, { breakerId: id });

  // The current implementation is read-only — in Phase 2 this will call
  // tripBreaker / resetBreaker functions. We acknowledge the action + audit.
  return okResponse({
    breaker: spec,
    action: body.action,
    reason: body.reason,
    triggeredBy: ctx.admin!.adminId,
    triggeredAt: new Date().toISOString(),
    note: "Phase 1 stub — Phase 2 will mutate the breaker state.",
  });
});
