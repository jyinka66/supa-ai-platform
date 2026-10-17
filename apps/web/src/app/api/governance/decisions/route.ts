// POST /api/governance/decisions
//
// Routes a decision request through the governance engine:
//   1. Check kill switches (block if active).
//   2. Assess risk (low / medium / high / critical / irreversible).
//   3. Apply policy rules (auto-approved, policy-approved, blocked).
//   4. If human approval required → defer + emit committee routing.
//
// Body: DecisionRequest
// Returns: { decision, riskLevel, policyKey, reasoning, decisionId }
//
// Auth: admin senior.

import { NextRequest } from "next/server";
import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody } from "@/lib/api/route-helpers";
import { routeDecision, assessRisk, type RiskLevel, type GovernanceDecision } from "@/lib/governance/decision-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  actionType: z.string().min(3).max(100),
  targetType: z.string().min(2).max(50),
  targetId: z.string().min(1).max(200),
  wsId: z.string().uuid().optional(),
  actorId: z.string().min(1).max(100),
  actorReputation: z.number().min(0).max(100).optional(),
  costUsd: z.number().min(0).max(1_000_000).optional(),
  isIrreversible: z.boolean().optional(),
});

export const POST = adminOnly("senior", async (req, ctx) => {
  const body = await parseJsonBody(req, BodySchema);

  const riskAssessment = assessRisk(body);
  const decision = await routeDecision(body);

  return okResponse({
    request: body,
    riskAssessment,
    decision,
    routedBy: ctx.admin!.adminId,
    routedAt: new Date().toISOString(),
  });
});

// GET /api/governance/decisions — list decisions (filterable)
export const GET = adminOnly("read_only", async (req, ctx) => {
  const url = new URL(req.url);
  const { listDecisions } = await import("@/lib/governance/decision-engine");
  const decisions = await listDecisions({
    targetType: url.searchParams.get("targetType") ?? undefined,
    riskLevel: (url.searchParams.get("riskLevel") as RiskLevel | null) ?? undefined,
    decision: (url.searchParams.get("decision") as GovernanceDecision | null) ?? undefined,
    wsId: url.searchParams.get("wsId") ?? undefined,
    limit: parseInt(url.searchParams.get("limit") ?? "50", 10),
  });
  return okResponse({ decisions, total: decisions.length });
});
