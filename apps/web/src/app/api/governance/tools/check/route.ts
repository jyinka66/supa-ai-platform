// POST /api/governance/tools/check
//
// Classifies a tool call into one of 6 categories (read_only, side_effect,
// financial, destructive, cross_workspace, cross_user) and checks whether
// the actor is allowed to execute it.
//
// Body:
//   toolKey: string
//   sideEffect: boolean
//   isFinancial: boolean
//   isDestructive: boolean
//   crossWorkspace: boolean
//   crossUser: boolean
//   wsId?: string
//   actorReputation?: number (0-100)
//   costUsd?: number
//   useCount?: number

import { NextRequest } from "next/server";
import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody } from "@/lib/api/route-helpers";
import { governToolCall, classifyToolCall, getToolGovernance } from "@/lib/governance/tool-execution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  toolKey: z.string().min(1).max(200),
  sideEffect: z.boolean(),
  isFinancial: z.boolean(),
  isDestructive: z.boolean(),
  crossWorkspace: z.boolean(),
  crossUser: z.boolean(),
  wsId: z.string().uuid().optional(),
  actorReputation: z.number().min(0).max(100).optional(),
  costUsd: z.number().min(0).max(1_000_000).optional(),
  useCount: z.number().int().min(0).optional(),
});

export const POST = adminOnly("read_only", async (req, ctx) => {
  const body = await parseJsonBody(req, BodySchema);

  const category = classifyToolCall(body);
  const toolGovernance = getToolGovernance(category);
  const result = await governToolCall({
    ...body,
    actorId: ctx.admin!.adminId,
  });

  return okResponse({
    request: body,
    category,
    toolGovernance,
    decision: result,
    checkedBy: ctx.admin!.adminId,
    checkedAt: new Date().toISOString(),
  });
});
