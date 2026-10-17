// POST /api/governance/agents/check
//
// Checks whether an agent is allowed to perform an action. Returns the
// 4-level governance verdict (allow / warn / deny / escalate) plus the
// matching rule.
//
// Body: AgentActionCheck input shape (config + actionType + toolKey + costUsd + ...)

import { NextRequest } from "next/server";
import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody } from "@/lib/api/route-helpers";
import { checkAgentAction, isProhibitedAction, PROHIBITED_ACTIONS, createDefaultAgentConfig } from "@/lib/governance/agent-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  actionType: z.string().min(3).max(100),
  toolKey: z.string().max(200).optional(),
  costUsd: z.number().min(0).max(1_000_000).optional(),
  cumulativeCostUsd: z.number().min(0).max(1_000_000).optional(),
  targetUserId: z.string().max(100).optional(),
  config: z.object({}).passthrough().optional(),
});

export const POST = adminOnly("read_only", async (req, ctx) => {
  const body = await parseJsonBody(req, BodySchema);

  const config = body.config ?? createDefaultAgentConfig({
    agentId: ctx.admin!.adminId,
    wsId: "default",
    scopes: [],
  });
  const prohibited = isProhibitedAction(body.actionType);

  const result = checkAgentAction({
    config: config as Parameters<typeof checkAgentAction>[0]["config"],
    actionType: body.actionType,
    toolKey: body.toolKey,
    costUsd: body.costUsd,
    cumulativeCostUsd: body.cumulativeCostUsd,
    targetUserId: body.targetUserId,
  });

  return okResponse({
    request: body,
    prohibited,
    result,
    prohibitedActions: PROHIBITED_ACTIONS,
    checkedBy: ctx.admin!.adminId,
    checkedAt: new Date().toISOString(),
  });
});
