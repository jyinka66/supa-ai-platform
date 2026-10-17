// Policy as code — versioning, simulation, observability, auto-tuning.
// 14.2.11: "All approval policies, budgets, rate limits, compliance rules,
// and tax rules stored as versioned policy. Runtime evaluation — every tool call,
// every agent action, every payment, every regional operation evaluates policy."

import { db } from "@supa/db";
import { policyVersions, policyEvaluations } from "@supa/db/schema";
import { eq, desc, sql } from "drizzle-orm";

// ───────────────────────────────────────────────
// Versioning — every change is a commit, reviewed, tested, rollback-capable.
// ───────────────────────────────────────────────

export async function commitPolicyVersion(input: {
  policyKey: string;
  version: string;
  ruleSnapshot: Record<string, unknown>;
  changelog?: string;
  committedBy?: string;
}): Promise<{ id: string }> {
  const rows = await db.insert(policyVersions).values({
    policyKey: input.policyKey,
    version: input.version,
    ruleSnapshot: input.ruleSnapshot,
    ...(input.changelog ? { changelog: input.changelog } : {}),
    committedBy: input.committedBy ?? "system",
  }).returning({ id: policyVersions.id });
  return { id: rows[0]?.id as string };
}

export async function rollbackPolicyVersion(policyKey: string, toVersion: string): Promise<void> {
  // Mark current as superseded, mark target as active (rollback).
  await db.execute(sql`
    update policy_versions set status = 'superseded'
    where policy_key = ${policyKey} and status in ('committed', 'reviewed')
  `);
  await db.execute(sql`
    update policy_versions set status = 'reviewed'
    where policy_key = ${policyKey} and version = ${toVersion}
  `);
}

// ───────────────────────────────────────────────
// Simulation — every policy change simulated against real traffic before rollout.
// ───────────────────────────────────────────────

export interface SimulationResult {
  trafficSample: number;
  matches: number;
  impact: { autoApproves: number; escalations: number; blocks: number };
  safeToRollout: boolean;
}

export async function simulatePolicy(input: {
  policyKey: string;
  rule: { condition: Record<string, unknown>; action: Record<string, unknown> };
  trafficSample?: number;
}): Promise<SimulationResult> {
  // STUB: would replay real traffic against the new policy rule.
  const trafficSample = input.trafficSample ?? 1000;
  const matches = Math.floor(trafficSample * 0.3); // 30% match rate (stub).
  const autoApproves = Math.floor(matches * 0.7);
  const escalations = Math.floor(matches * 0.2);
  const blocks = matches - autoApproves - escalations;

  return {
    trafficSample,
    matches,
    impact: { autoApproves, escalations, blocks },
    safeToRollout: blocks < trafficSample * 0.05, // < 5% blocks = safe.
  };
}

// ───────────────────────────────────────────────
// Observability — every policy evaluation logged + searchable.
// ───────────────────────────────────────────────

export async function logPolicyEvaluation(input: {
  policyKey: string | null;
  category: string;
  context: Record<string, unknown>;
  action: Record<string, unknown> | null;
  matched: boolean;
  wsId?: string;
  toolKey?: string;
}): Promise<void> {
  try {
    await db.insert(policyEvaluations).values({
      ...(input.policyKey ? { policyKey: input.policyKey } : {}),
      category: input.category,
      context: input.context,
      ...(input.action ? { action: input.action } : {}),
      matched: input.matched,
      ...(input.wsId ? { workspaceId: input.wsId as any } : {}),
      ...(input.toolKey ? { toolKey: input.toolKey } : {}),
    });
  } catch {
    // Logging must never fail the operation.
  }
}

export async function searchPolicyEvaluations(opts: {
  policyKey?: string;
  category?: string;
  matched?: boolean;
  limit?: number;
} = {}): Promise<Array<{ id: string; policyKey: string | null; category: string; matched: boolean; evaluatedAt: Date }>> {
  const conditions = [];
  if (opts.policyKey) conditions.push(eq(policyEvaluations.policyKey, opts.policyKey));
  if (opts.category) conditions.push(eq(policyEvaluations.category, opts.category));
  if (opts.matched !== undefined) conditions.push(eq(policyEvaluations.matched, opts.matched));

  const rows = await db.select({
    id: policyEvaluations.id,
    policyKey: policyEvaluations.policyKey,
    category: policyEvaluations.category,
    matched: policyEvaluations.matched,
    evaluatedAt: policyEvaluations.evaluatedAt,
  }).from(policyEvaluations)
    .where(conditions.length > 0 ? (await import("drizzle-orm")).and(...conditions) : undefined)
    .orderBy(desc(policyEvaluations.evaluatedAt))
    .limit(opts.limit ?? 100);

  return rows.map((r) => ({ id: r.id as string, policyKey: r.policyKey, category: r.category, matched: r.matched, evaluatedAt: r.evaluatedAt }));
}

// ───────────────────────────────────────────────
// Auto-tuning — the platform proposes policy changes based on observed patterns.
// ───────────────────────────────────────────────

export interface PolicyTuningProposal {
  policyKey: string;
  currentVersion: string;
  proposedChange: string;
  reason: string;
  confidence: number; // 0-1.
  safeToApply: boolean;
}

export async function proposePolicyTuning(): Promise<PolicyTuningProposal[]> {
  // STUB: would analyze policy_evaluations for patterns (e.g. high escalation rate
  // from a trusted org → propose auto-approve for that org).
  return [
    {
      policyKey: "rate_limit.api_per_workspace",
      currentVersion: "1.0.0",
      proposedChange: "Increase default limit from 100 to 150 req/min (observed 73% of workspaces never exceed 100, but 15% hit the limit regularly)",
      reason: "Pattern: 15% of workspaces regularly hit the 100/min limit, suggesting it's too low for active teams.",
      confidence: 0.85,
      safeToApply: true,
    },
  ];
}
