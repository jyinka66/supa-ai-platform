// POST /api/governance/decisions/log
// GET  /api/governance/decisions/log
//
// POST: appends an entry to the hash-chained decision log.
// GET:  queries the decision log by actor / action / time range.

import { NextRequest } from "next/server";
import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody, paginate } from "@/lib/api/route-helpers";
import {
  appendDecisionLog,
  queryDecisionLog,
  type DecisionLogEntry,
} from "@/lib/governance/governance-decision-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AppendBodySchema = z.object({
  actor: z.string().min(1).max(100),
  action: z.string().min(3).max(100),
  context: z.object({
    targetType: z.string().min(1).max(50),
    targetId: z.string().min(1).max(200),
    wsId: z.string().uuid().optional(),
  }).passthrough(),
  policyApplied: z.object({
    key: z.string().nullable(),
    version: z.number().int().nullable(),
    result: z.enum(["allow", "deny", "warn", "defer", "not_applicable"]),
  }),
  decision: z.enum(["auto_approved", "policy_approved", "human_approved", "blocked", "deferred"]),
  riskLevel: z.enum(["low", "medium", "high", "critical", "irreversible"]),
});

export const POST = adminOnly("senior", async (req, ctx) => {
  const body = await parseJsonBody(req, AppendBodySchema);

  const entry = {
    timestamp: new Date(),
    actor: body.actor,
    action: body.action,
    context: body.context,
    policyApplied: body.policyApplied,
    decision: body.decision,
    riskLevel: body.riskLevel,
  } as unknown as DecisionLogEntry;

  const result = await appendDecisionLog(entry);

  return okResponse({
    result,
    appendedBy: ctx.admin!.adminId,
    appendedAt: new Date().toISOString(),
  });
});

export const GET = adminOnly("read_only", async (req, ctx) => {
  const url = new URL(req.url);
  const pagination = paginate(url, { pageSize: 50 });

  const entries = await queryDecisionLog({
    actorId: url.searchParams.get("actorId") ?? undefined,
    action: url.searchParams.get("action") ?? undefined,
    decision: url.searchParams.get("decision") ?? undefined,
    wsId: url.searchParams.get("wsId") ?? undefined,
    fromTs: url.searchParams.get("fromTs") ? new Date(url.searchParams.get("fromTs")!) : undefined,
    toTs: url.searchParams.get("toTs") ? new Date(url.searchParams.get("toTs")!) : undefined,
    limit: pagination.take,
    offset: pagination.skip,
  });

  return okResponse({
    entries,
    page: pagination.page,
    pageSize: pagination.pageSize,
    total: entries.length,
  });
});
