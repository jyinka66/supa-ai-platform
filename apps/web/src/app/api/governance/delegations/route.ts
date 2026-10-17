// POST /api/governance/delegations
//
// Creates a delegation — allows one user to act on behalf of another for a
// specific action type, target type, and scope.
//
// Body:
//   actionType: string (e.g. "tool.call", "agent.run")
//   targetType: string (e.g. "tool", "agent", "deployment")
//   delegateeId: string (the user receiving the delegation)
//   scopeType: "global" | "workspace" | "region" | "vertical"
//   scopeFilter?: Record<string, unknown>
//   conditions?: Record<string, unknown>
//   expiresAt?: ISO date string

import { NextRequest } from "next/server";
import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody } from "@/lib/api/route-helpers";
import { createDelegation, type DelegationScope } from "@/lib/governance/delegations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  actionType: z.string().min(3).max(100),
  targetType: z.string().min(2).max(50),
  delegateeId: z.string().min(1).max(100),
  scopeType: z.enum(["global", "workspace", "region", "vertical"]) as z.ZodType<DelegationScope>,
  scopeFilter: z.record(z.string(), z.unknown()).optional(),
  conditions: z.record(z.string(), z.unknown()).optional(),
  expiresAt: z.string().datetime().optional(),
});

export const POST = adminOnly("senior", async (req, ctx) => {
  const body = await parseJsonBody(req, BodySchema);

  const delegation = await createDelegation({
    actionType: body.actionType,
    targetType: body.targetType,
    delegatorId: ctx.admin!.adminId,
    delegateeId: body.delegateeId,
    scopeType: body.scopeType,
    scopeFilter: body.scopeFilter,
    conditions: body.conditions,
    expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
  });

  return okResponse({
    delegation,
    delegatedBy: ctx.admin!.adminId,
    delegatedAt: new Date().toISOString(),
  });
});
