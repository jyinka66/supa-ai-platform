// Budget ledger — atomic, the release-lock lesson applied to tokens.
// Hold-then-capture, atomically. The check-and-hold is ONE transaction,
// so N concurrent runs cannot race past the cap (the escrow lesson).
// Uses SELECT ... FOR UPDATE on a per-agent budget lock row.

import { db } from "@supa/db";
import { budgetEntries, runs, activityFacts } from "@supa/db/schema";
import { sql, eq, and, gte, lte } from "drizzle-orm";
import type { BudgetSpec } from "../schema.js";

// FIX: inlined recordActivity (same pattern as all other packages).
async function recordActivity(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: { wsId: string; kind: string; ref: Record<string, unknown> },
): Promise<void> {
  await tx.insert(activityFacts).values({
    workspaceId: input.wsId,
    kind: input.kind,
    refId: JSON.stringify(input.ref),
    occurredAt: new Date(),
    actor: "system",
    source: "system",
  });
}

export interface BudgetDecision {
  allowed: boolean;
  committedMinor: number;   // what was actually held
  reason?: "daily_cap" | "monthly_cap" | "run_cap" | "ws_pool_exhausted";
}

/**
 * Emit a budget alert activity fact. Called when a cap is hit or
 * when an alert threshold is crossed.
 */
async function emitBudgetAlert(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  wsId: string,
  agentId: string,
  kind: "daily_cap" | "monthly_cap" | "alert",
  spent: number,
  cap: number,
  pct?: number,
): Promise<void> {
  await recordActivity(tx, {
    wsId,
    kind: "agent.budget.alert",
    ref: { agentId, kind, spent, cap, ...(pct !== undefined ? { pct } : {}) },
  });
  // Also insert a budget_entries row with kind='alert' for queryability.
  const today = new Date().toISOString().slice(0, 10);
  await tx.insert(budgetEntries).values({
    workspaceId: wsId as any,
    agentId: agentId as any,
    runId: null,
    usdMinor: 0,
    kind: "alert",
    periodDay: today,
  });
}

/**
 * Hold-then-capture, atomically. The check-and-hold is ONE transaction,
 * so N concurrent runs cannot race past the cap (the escrow lesson).
 * Uses a per-agent advisory lock to serialize concurrent holds.
 */
export async function holdBudget(
  wsId: string, agentId: string, runId: string,
  spec: BudgetSpec, estMinor: number,
): Promise<BudgetDecision> {
  return db.transaction(async (tx) => {
    // FIX: use Postgres advisory lock instead of a non-existent agent_budget_lock table.
    // Advisory lock keyed on agent_id (hashed to bigint) — serializes all concurrent holds.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${agentId}))`);

    const today = new Date().toISOString().slice(0, 10);
    const monthStart = today.slice(0, 7) + "-01";
    const monthEnd = today.slice(0, 7) + "-31";

    // FIX: replaced broken raw SQL with Drizzle queries.
    // Sum today's holds + captures.
    const dayResult = await tx
      .select({ total: sql<string>`coalesce(sum(${budgetEntries.usdMinor}), 0)` })
      .from(budgetEntries)
      .where(and(
        eq(budgetEntries.agentId, agentId as any),
        eq(budgetEntries.periodDay, today),
        sql`${budgetEntries.kind} in ('hold', 'capture')`,
      ));
    const spentDay = Number(dayResult[0]?.total ?? 0);

    // Sum this month's holds + captures.
    const monthResult = await tx
      .select({ total: sql<string>`coalesce(sum(${budgetEntries.usdMinor}), 0)` })
      .from(budgetEntries)
      .where(and(
        eq(budgetEntries.agentId, agentId as any),
        gte(budgetEntries.periodDay, monthStart),
        lte(budgetEntries.periodDay, monthEnd),
        sql`${budgetEntries.kind} in ('hold', 'capture')`,
      ));
    const spentMonth = Number(monthResult[0]?.total ?? 0);

    // Count today's runs.
    const runResult = await tx
      .select({ count: sql<string>`count(*)` })
      .from(runs)
      .where(and(
        eq(runs.agentId, agentId as any),
        sql`date(${runs.createdAt}) = ${today}`,
      ));
    const runsToday = Number(runResult[0]?.count ?? 0);

    // Check run cap.
    if (runsToday >= spec.maxRunsPerDay) {
      return { allowed: false, committedMinor: 0, reason: "run_cap" };
    }

    // Check daily cap.
    if (spentDay + estMinor > spec.dailyUsdMinor) {
      await emitBudgetAlert(tx, wsId, agentId, "daily_cap", spentDay, spec.dailyUsdMinor);
      return { allowed: false, committedMinor: 0, reason: "daily_cap" };
    }

    // Check monthly cap.
    if (spentMonth + estMinor > spec.monthlyUsdMinor) {
      await emitBudgetAlert(tx, wsId, agentId, "monthly_cap", spentMonth, spec.monthlyUsdMinor);
      return { allowed: false, committedMinor: 0, reason: "monthly_cap" };
    }

    // Alert thresholds fire on committed spend, exactly once per pct.
    for (const pct of spec.alertAtPct) {
      const threshold = Math.floor((spec.dailyUsdMinor * pct) / 100);
      if (spentDay < threshold && spentDay + estMinor >= threshold) {
        await emitBudgetAlert(tx, wsId, agentId, "alert", spentDay + estMinor, spec.dailyUsdMinor, pct);
      }
    }

    // Insert the hold entry.
    await tx.insert(budgetEntries).values({
      workspaceId: wsId as any,
      agentId: agentId as any,
      runId: runId as any,
      usdMinor: estMinor,
      kind: "hold",
      periodDay: today,
    });

    return { allowed: true, committedMinor: estMinor };
  });
}

/** Capture actuals; refund the unspent difference. Idempotent per (run, kind). */
export async function captureBudget(
  wsId: string, agentId: string, runId: string, actualMinor: number,
): Promise<void> {
  await db.transaction(async (tx) => {
    // Lock the agent's budget — same advisory lock.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${agentId}))`);

    // Sum holds and captures for this run.
    const result = await tx
      .select({
        held: sql<string>`coalesce(sum(case when ${budgetEntries.kind} = 'hold' then ${budgetEntries.usdMinor} else 0 end), 0)`,
        captured: sql<string>`coalesce(sum(case when ${budgetEntries.kind} = 'capture' then ${budgetEntries.usdMinor} else 0 end), 0)`,
      })
      .from(budgetEntries)
      .where(eq(budgetEntries.runId, runId as any));

    const held = Number(result[0]?.held ?? 0);
    const captured = Number(result[0]?.captured ?? 0);
    const delta = held - captured - actualMinor;

    if (delta < 0) {
      throw new Error(`budget_reconcile_broken: run ${runId} negative refund (held=${held}, captured=${captured}, actual=${actualMinor})`);
    }

    const today = new Date().toISOString().slice(0, 10);

    // Insert the capture entry.
    await tx.insert(budgetEntries).values({
      workspaceId: wsId as any,
      agentId: agentId as any,
      runId: runId as any,
      usdMinor: actualMinor,
      kind: "capture",
      periodDay: today,
    });

    // Refund the unspent difference.
    if (delta > 0) {
      await tx.insert(budgetEntries).values({
        workspaceId: wsId as any,
        agentId: agentId as any,
        runId: runId as any,
        usdMinor: delta,
        kind: "refund",
        periodDay: today,
      });
    }
  });
}

/**
 * Compute the current spend for an agent (derived, never stored as a balance).
 * Same no-drift rule as every other derived number in the system.
 */
export async function computeAgentSpend(
  agentId: string,
  periodDay: string,
): Promise<{ held: number; captured: number; refunded: number; alerts: number; net: number }> {
  const result = await db
    .select({
      held: sql<string>`coalesce(sum(case when ${budgetEntries.kind} = 'hold' then ${budgetEntries.usdMinor} else 0 end), 0)`,
      captured: sql<string>`coalesce(sum(case when ${budgetEntries.kind} = 'capture' then ${budgetEntries.usdMinor} else 0 end), 0)`,
      refunded: sql<string>`coalesce(sum(case when ${budgetEntries.kind} = 'refund' then ${budgetEntries.usdMinor} else 0 end), 0)`,
      alerts: sql<string>`coalesce(sum(case when ${budgetEntries.kind} = 'alert' then 1 else 0 end), 0)`,
    })
    .from(budgetEntries)
    .where(and(
      eq(budgetEntries.agentId, agentId as any),
      eq(budgetEntries.periodDay, periodDay),
    ));

  const held = Number(result[0]?.held ?? 0);
  const captured = Number(result[0]?.captured ?? 0);
  const refunded = Number(result[0]?.refunded ?? 0);
  const alerts = Number(result[0]?.alerts ?? 0);

  return {
    held,
    captured,
    refunded,
    alerts,
    net: held - refunded, // net committed = holds minus refunds
  };
}
