// POST /api/governance/kill-switches/[id]/trigger
//
// Activates a kill switch. The propagation must complete within the 60-second
// SLA (subscribers must be notified and stop accepting the gated action).
//
// Body:
//   reason: string
//   autoDeactivateInHours?: number (default: null = manual deactivation only)
//   scope?: "global" | "feature" | "region" | "vertical" | "workspace" | "tool" | "agent"
//   scopeId?: string

import { NextRequest } from "next/server";
import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody, withRateLimit } from "@/lib/api/route-helpers";
import {
  activateKillSwitchByType,
  KILL_SWITCH_TYPES,
} from "@/lib/governance/kill-switches";
import { ApiError } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  reason: z.string().min(10).max(2000),
  autoDeactivateInHours: z.number().int().min(1).max(720).optional(),
  scope: z.enum(["global", "feature", "region", "vertical", "workspace", "tool", "agent"]).optional(),
  scopeId: z.string().max(200).optional(),
});

export const POST = adminOnly("owner", async (req, ctx) => {
  // Rate limit: 2 kill switch activations per admin per minute
  // (governanceKillSwitch tier). Cooling-off prevents accidental flip-flops.
  const rl = await withRateLimit(req, ctx.admin!.adminId);
  if (rl) return rl;

  const id = (req as unknown as { params?: Record<string, string | undefined> }).params?.id;
  if (!id) throw new ApiError("not_found", 404, { param: "id" });

  const body = await parseJsonBody(req, BodySchema);

  // First check if `id` is a kill switch type (e.g. "global_halt") —
  // activateKillSwitchByType handles type-based activation.
  const typeSpec = KILL_SWITCH_TYPES.find((t) => t.type === id);
  if (!typeSpec) throw new ApiError("not_found", 404, { killSwitchType: id });

  const result = await activateKillSwitchByType({
    type: typeSpec.type,
    reason: body.reason,
    activatedBy: ctx.admin!.adminId,
    autoDeactivateInHours: body.autoDeactivateInHours,
    scopeFilter: body.scope && body.scopeId ? { scope: body.scope, scopeId: body.scopeId } : undefined,
  });

  return okResponse({
    killSwitchType: id,
    activation: result,
    triggeredBy: ctx.admin!.adminId,
    triggeredAt: new Date().toISOString(),
  });
});
