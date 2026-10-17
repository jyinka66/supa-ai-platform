// Observability dashboard queries — per agent, per workspace.
//
// Four queries power the agent observability dashboard:
//
//   runHealth        — per-agent run status + p50/p95 duration, last 24h.
//                      Answers: "which agents are slow? which are failing?"
//
//   spendVsCap       — per-agent spend today vs daily cap (budget bar).
//                      Answers: "which agents are burning through their cap?"
//
//   approvalFriction — per-agent inbox load + median decision time.
//                      Answers: "which agents are bottlenecked on approvals?"
//
//   agentQuality     — per-agent loop/rate-limit/max_steps errors, last 7d.
//                      Answers: "which agents are misbehaving?" (looping,
//                      hitting rate limits, running out of steps).
//
// All four are READ-ONLY + scoped to ws_id. The caller's session RLS already
// enforces tenancy; the WHERE clause is the explicit scope (defense-in-depth
// + makes the query plan obvious to the planner).
//
// RAW SQL via Drizzle's 'sql' tag: the queries use 'percentile_disc' + 'filter'
// clauses that are far more readable as SQL than as Drizzle builder calls.
// Drizzle's 'sql' tag parameterizes safely (no string concatenation → no SQL
// injection). The result is typed via explicit interfaces.

import { db } from "@supa/db";
import { sql } from "drizzle-orm";

// ───────────────────────────────────────────────
// runHealth — per-agent run status + p50/p95 duration, last 24h
// ───────────────────────────────────────────────

export interface RunHealthRow {
  agentId: string;
  status: string;
  count: number;
  /** p50 run duration in seconds. null if no finished runs in the window. */
  p50Seconds: number | null;
  /** p95 run duration in seconds. null if fewer than 20 finished runs (p95 is
   *  noisy with small samples; null signals "not enough data"). */
  p95Seconds: number | null;
}

/**
 * Per-agent run health, last 24h. Groups by (agent_id, status) so the
 * dashboard can render a status breakdown per agent (e.g. 30 done, 2 failed,
 * 1 timed_out).
 *
 * Duration = finished_at - created_at (in seconds, via extract(epoch from ...)).
 * Only runs with both timestamps set contribute to p50/p95 (the 'filter'
 * clause excludes nulls — runs that haven't finished yet have no duration).
 */
export async function runHealth(wsId: string): Promise<RunHealthRow[]> {
  const rows = await db.execute(sql`
    select
      agent_id,
      status,
      count(*) as count,
      percentile_disc(0.5) within group (
        order by extract(epoch from (finished_at - created_at))
      ) filter (where finished_at is not null) as p50_s,
      percentile_disc(0.95) within group (
        order by extract(epoch from (finished_at - created_at))
      ) filter (where finished_at is not null) as p95_s
    from runs
    where ws_id = ${wsId}
      and created_at > now() - interval '24 hours'
    group by agent_id, status
    order by agent_id, status
  `);
  const typedRows = rows as unknown as { rows: { agent_id: string; status: string; count: string; p50_s: string | null; p95_s: string | null }[] };
  return typedRows.rows.map((r) => ({
    agentId: r.agent_id,
    status: r.status,
    count: Number(r.count),
    p50Seconds: r.p50_s != null ? Number(r.p50_s) : null,
    p95Seconds: r.p95_s != null ? Number(r.p95_s) : null,
  }));
}

// ───────────────────────────────────────────────
// spendVsCap — per-agent spend today vs daily cap (budget bar)
// ───────────────────────────────────────────────

export interface SpendVsCapRow {
  agentId: string;
  /** Total captured spend today, in usd_minor (the actual cost, not the hold). */
  spentMinor: number;
  /** Daily cap from the agent's budget spec, in usd_minor. null if the spec
   *  is malformed (shouldn't happen — the BudgetSpec Zod schema enforces it). */
  dailyCapMinor: number | null;
  /** Spend as a fraction of cap (0..1+). >1 means over cap. null if cap is null. */
  pctOfCap: number | null;
}

/**
 * Per-agent spend today vs daily cap. The "budget bar" — renders as a
 * percentage-of-cap per agent. Over-cap agents (pct > 1) are highlighted.
 *
 * FIX from the pasted spec: a.spec->'budget' was wrong — the `agents` table
 * has `budget` (jsonb), not `spec`. Fixed to a.budget->>'dailyUsdMinor'.
 *
 * period_day = current_date::text — the `period_day` column is stored as
 * text (YYYY-MM-DD); the explicit cast makes the comparison unambiguous
 * (Postgres would coerce implicitly, but explicit is better for the planner).
 */
export async function spendVsCap(wsId: string): Promise<SpendVsCapRow[]> {
  const rows = await db.execute(sql`
    select
      b.agent_id,
      sum(case when b.kind = 'capture' then b.usd_minor else 0 end) as spent,
      (a.budget->>'dailyUsdMinor')::int as cap
    from budget_entries b
    join agents a on a.id = b.agent_id
    where b.ws_id = ${wsId}
      and b.period_day = current_date::text
    group by b.agent_id, a.budget
    order by b.agent_id
  `);
  const typedRows = rows as unknown as { rows: { agent_id: string; spent: string; cap: string | null }[] };
  return typedRows.rows.map((r) => {
    const spentMinor = Number(r.spent);
    const dailyCapMinor = r.cap != null ? Number(r.cap) : null;
    return {
      agentId: r.agent_id,
      spentMinor,
      dailyCapMinor,
      pctOfCap: dailyCapMinor != null && dailyCapMinor > 0
        ? spentMinor / dailyCapMinor
        : null,
    };
  });
}

// ───────────────────────────────────────────────
// approvalFriction — per-agent inbox load + median decision time
// ───────────────────────────────────────────────

export interface ApprovalFrictionRow {
  agentId: string;
  /** Count of pending approvals (inbox load right now). */
  pending: number;
  /** Count of approvals that expired (48h window for two-gate, 24h for one-gate)
   *  without a decision. High expired = the approver isn't responding. */
  expired48h: number;
  /** Median decision time in seconds (decided_at - created_at). null if no
   *  decided approvals (all pending or all expired). */
  medianDecisionSeconds: number | null;
}

/**
 * Per-agent approval friction. Three signals:
 *   - pending: inbox load right now (how many approvals are waiting).
 *   - expired_48h: approvals that timed out without a decision (the approver
 *     isn't responding — the agent is blocked).
 *   - median_decision_s: how long decisions typically take (low = responsive
 *     approver; high = the agent is bottlenecked on the human).
 *
 * decided_at - created_at computes the decision latency. Only decided
 * approvals contribute (the `filter (where decided_at is not null)` clause).
 */
export async function approvalFriction(wsId: string): Promise<ApprovalFrictionRow[]> {
  const rows = await db.execute(sql`
    select
      agent_id,
      count(*) filter (where status = 'pending') as pending,
      count(*) filter (where status = 'expired') as expired_48h,
      percentile_disc(0.5) within group (
        order by extract(epoch from (decided_at - created_at))
      ) filter (where decided_at is not null) as median_decision_s
    from approvals
    where ws_id = ${wsId}
    group by agent_id
    order by agent_id
  `);
  const typedRows = rows as unknown as { rows: { agent_id: string; pending: string; expired_48h: string; median_decision_s: string | null }[] };
  return typedRows.rows.map((r) => ({
    agentId: r.agent_id,
    pending: Number(r.pending),
    expired48h: Number(r.expired_48h),
    medianDecisionSeconds: r.median_decision_s != null ? Number(r.median_decision_s) : null,
  }));
}

// ───────────────────────────────────────────────
// agentQuality — loop/rate-limit/max_steps errors, last 7d
// ───────────────────────────────────────────────

export interface AgentQualityRow {
  agentId: string;
  /** The failure reason: 'loop_detected' | 'tool_rate_limit' | 'max_steps'.
   *  These are the executor's loop-guard failure modes — a high count means
   *  the agent is misbehaving (stuck in a loop, calling a tool too many
   *  times, or running out of steps before finishing). */
  reason: string;
  /** Count of runs that hit this failure in the last 7 days. */
  count: number;
}

/**
 * Per-agent quality signal — loop/rate-limit/max_steps failures, last 7d.
 *
 * FIX from the pasted spec: the spec queried reason in ('loop_detected',...)
 * but the 'run_steps' table has 'error' (not 'reason'). And ts > now() - ...
 * but the table has 'created_at' (not `ts`). Both fixed.
 *
 * The join to 'runs' is needed to get 'agent_id' — 'run_steps' itself only
 * has 'run_id'; the agent comes from the parent run row. (The pasted spec
 * selected 'agent_id' from 'run_steps' directly, which would have failed at
 * runtime — 'run_steps' has no 'agent_id' column.)
 *
 * The 'reason' values come from the executor's recordStep(ctx, 'error', ...)
 * calls — the executor records `loop_detected`, `tool_rate_limit`, `max_steps`,
 * `killswitch`, `wall_deadline`, `run_not_found`, `tool_unregistered_on_resume`,
 * etc. as the 'error' column on run_steps with kind='error'. This query
 * filters to the three loop-guard failure modes (the "agent quality" signal —
 * the others are external/system issues, not agent behavior).
 */
export async function agentQuality(wsId: string): Promise<AgentQualityRow[]> {
  const rows = await db.execute(sql`
    select
      r.agent_id,
      rs.error as reason,
      count(*) as count
    from run_steps rs
    join runs r on r.id = rs.run_id
    where rs.kind = 'error'
      and rs.error in ('loop_detected', 'tool_rate_limit', 'max_steps')
      and rs.ws_id = ${wsId}
      and rs.created_at > now() - interval '7 days'
    group by r.agent_id, rs.error
    order by r.agent_id, count desc
  `);
  const typedRows = rows as unknown as { rows: { agent_id: string; reason: string; count: string }[] };
  return typedRows.rows.map((r) => ({
    agentId: r.agent_id,
    reason: r.reason,
    count: Number(r.count),
  }));
}

// ───────────────────────────────────────────────
// dashboardSummary — all four queries in one call
// ───────────────────────────────────────────────

export interface DashboardSummary {
  runHealth: RunHealthRow[];
  spendVsCap: SpendVsCapRow[];
  approvalFriction: ApprovalFrictionRow[];
  agentQuality: AgentQualityRow[];
}

/**
 * Fetch all four dashboard queries in parallel. The dashboard UI calls this
 * once on page load (four queries fired concurrently via Promise.all —
 * ~1 round-trip each, all scoped to ws_id).
 *
 * The summary is a SNAPSHOT, not a live stream. The dashboard can poll on
 * an interval (e.g. every 30s) for near-real-time. A future impl may swap
 * to a websocket push (the facts stream already carries the underlying
 * events — a subscriber could maintain a rolling summary).
 */
export async function dashboardSummary(wsId: string): Promise<DashboardSummary> {
  const [health, spend, friction, quality] = await Promise.all([
    runHealth(wsId),
    spendVsCap(wsId),
    approvalFriction(wsId),
    agentQuality(wsId),
  ]);
  return {
    runHealth: health,
    spendVsCap: spend,
    approvalFriction: friction,
    agentQuality: quality,
  };
}
