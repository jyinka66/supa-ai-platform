// SLO tracking + error budgets.
//
// An SLO (Service Level Objective) is a target for a service's reliability
// (e.g. "99.9% availability over 30 days"). The error budget is the allowed
// failure rate (0.1% for a 99.9% SLO). When the budget is consumed > the
// alert threshold (default 50%), alert the on-call — the service is burning
// its budget too fast + will breach the SLO if the trend continues.
//
// The spec: "Reliability — SLOs per service, error budgets, graceful
// degradation, circuit breakers, retries with backoff, idempotency, health
// checks, status page, runbooks, post-incident reviews."
//
// Flow:
//   1. SLOs are defined in the `slo_definitions` table (seeded in migration
//      0051: api/ai/web/background_jobs/auth/payments).
//   2. A periodic job (the SLO snapshot cron) measures the SLI (the actual
//      value — e.g. 0.9991 availability) + computes the error-budget
//      consumption → inserts an `slo_snapshots` row.
//   3. The /api/admin/slos endpoint reads the latest snapshots → shows the
//      dashboard (SLO target vs SLI actual, error budget consumed/remaining,
//      alert status).
//   4. If error_budget_consumed > alert_threshold → the cron emits an alert.
//
// This module provides:
//   - listSlos() — all SLO definitions + their latest snapshot.
//   - recordSnapshot() — the cron calls this to persist a measurement.
//   - computeErrorBudget() — pure function (for unit tests).
//   - isAlerting() — whether an SLO is in alert state (budget > threshold).

import { db } from "@supa/db";
import { sloDefinitions, sloSnapshots } from "@supa/db/schema";
import { eq, desc, sql } from "drizzle-orm";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type SloTargetUnit = "ratio" | "ms" | "seconds";

export interface SloDefinition {
  id: string;
  service: string;
  sloName: string;
  description: string;
  target: number;
  targetUnit: SloTargetUnit;
  windowDays: number;
  alertThreshold: number; // 0.0 to 1.0.
  owner: string;
}

export interface SloSnapshot {
  id: string;
  sloId: string;
  snapshotAt: Date;
  sliValue: number;
  sliUnit: string;
  errorBudgetRemaining: number; // 0.0 to 1.0.
  errorBudgetConsumed: number;  // 0.0 to 1.0.
  sampleCount: number;
  metadata: Record<string, unknown>;
}

export interface SloWithSnapshot extends SloDefinition {
  latestSnapshot: SloSnapshot | null;
  alerting: boolean; // whether error_budget_consumed > alert_threshold.
}

// ───────────────────────────────────────────────
// Pure functions (for unit tests)
// ───────────────────────────────────────────────

/**
 * Compute the error-budget consumption for an SLI vs an SLO target.
 *
 * For 'ratio' targets (availability): the error budget is (1 - target).
 *   consumed = max(0, (target - sli)) / (1 - target).
 *   - If sli >= target → consumed = 0 (budget intact).
 *   - If sli = target → consumed = 0 (exactly at the SLO).
 *   - If sli < target → consumed > 0 (budget being consumed).
 *   - If sli = 0 → consumed = 1 (budget fully consumed → SLO breached).
 *
 * For 'ms'/'seconds' targets (latency): the SLI is a p95 (lower is better).
 *   The target is the threshold (e.g. 300ms). If sli <= target → budget
 *   intact. If sli > target → budget consumed proportionally.
 *   consumed = max(0, (sli - target) / target).
 *   - If sli = 600ms, target = 300ms → consumed = 1.0 (2x over → full consumption).
 *
 * @returns { remaining: number, consumed: number } — both 0.0 to 1.0.
 */
export function computeErrorBudget(
  sliValue: number,
  target: number,
  targetUnit: SloTargetUnit,
): { remaining: number; consumed: number } {
  if (targetUnit === "ratio") {
    const budget = 1 - target; // e.g. 0.001 for a 99.9% SLO.
    if (budget <= 0) return { remaining: 0, consumed: 1 }; // 100% SLO → no budget.
    const consumed = Math.max(0, Math.min(1, (target - sliValue) / budget));
    return { remaining: 1 - consumed, consumed };
  }

  // Latency: lower is better. target is the threshold.
  if (target <= 0) return { remaining: 0, consumed: 1 };
  const overage = Math.max(0, sliValue - target);
  const consumed = Math.min(1, overage / target);
  return { remaining: 1 - consumed, consumed };
}

/**
 * Determine if an SLO is in alert state (error budget consumed > threshold).
 */
export function isAlerting(consumed: number, alertThreshold: number): boolean {
  return consumed > alertThreshold;
}

// ───────────────────────────────────────────────
// DB-backed functions
// ───────────────────────────────────────────────

/**
 * List all SLO definitions + their latest snapshot.
 */
export async function listSlos(): Promise<SloWithSnapshot[]> {
  const defs = await db
    .select({
      id: sloDefinitions.id,
      service: sloDefinitions.service,
      sloName: sloDefinitions.sloName,
      description: sloDefinitions.description,
      target: sloDefinitions.target,
      targetUnit: sloDefinitions.targetUnit,
      windowDays: sloDefinitions.windowDays,
      alertThreshold: sloDefinitions.alertThreshold,
      owner: sloDefinitions.owner,
    })
    .from(sloDefinitions)
    .orderBy(sloDefinitions.service, sloDefinitions.sloName);

  const result: SloWithSnapshot[] = [];
  for (const d of defs) {
    // Fetch the latest snapshot.
    const snaps = await db
      .select({
        id: sloSnapshots.id,
        sloId: sloSnapshots.sloId,
        snapshotAt: sloSnapshots.snapshotAt,
        sliValue: sloSnapshots.sliValue,
        sliUnit: sloSnapshots.sliUnit,
        errorBudgetRemaining: sloSnapshots.errorBudgetRemaining,
        errorBudgetConsumed: sloSnapshots.errorBudgetConsumed,
        sampleCount: sloSnapshots.sampleCount,
        metadata: sloSnapshots.metadata,
      })
      .from(sloSnapshots)
      .where(eq(sloSnapshots.sloId, d.id as any))
      .orderBy(desc(sloSnapshots.snapshotAt))
      .limit(1);

    const snapshot = snaps[0];
    const latestSnapshot: SloSnapshot | null = snapshot
      ? {
          id: snapshot.id as string,
          sloId: snapshot.sloId as string,
          snapshotAt: snapshot.snapshotAt,
          sliValue: Number(snapshot.sliValue),
          sliUnit: snapshot.sliUnit,
          errorBudgetRemaining: Number(snapshot.errorBudgetRemaining),
          errorBudgetConsumed: Number(snapshot.errorBudgetConsumed),
          sampleCount: snapshot.sampleCount,
          metadata: (snapshot.metadata as Record<string, unknown>) ?? {},
        }
      : null;

    const consumed = latestSnapshot?.errorBudgetConsumed ?? 0;
    const alertThreshold = Number(d.alertThreshold);
    result.push({
      id: d.id as string,
      service: d.service,
      sloName: d.sloName,
      description: d.description,
      target: Number(d.target),
      targetUnit: d.targetUnit as SloTargetUnit,
      windowDays: d.windowDays,
      alertThreshold,
      owner: d.owner,
      latestSnapshot,
      alerting: isAlerting(consumed, alertThreshold),
    });
  }

  return result;
}

/**
 * Record an SLO snapshot (the cron calls this).
 *
 * Computes the error-budget consumption + persists the snapshot.
 */
export async function recordSnapshot(
  sloId: string,
  sliValue: number,
  sampleCount: number,
  metadata: Record<string, unknown> = {},
): Promise<SloSnapshot> {
  // Fetch the SLO definition (for the target + unit).
  const defs = await db
    .select({
      target: sloDefinitions.target,
      targetUnit: sloDefinitions.targetUnit,
    })
    .from(sloDefinitions)
    .where(eq(sloDefinitions.id, sloId as any))
    .limit(1);
  const def = defs[0];
  if (!def) throw new Error(`slo_not_found:${sloId}`);

  const target = Number(def.target);
  const targetUnit = def.targetUnit as SloTargetUnit;
  const { remaining, consumed } = computeErrorBudget(sliValue, target, targetUnit);

  const rows = await db
    .insert(sloSnapshots)
    .values({
      sloId: sloId as any,
      sliValue: sliValue.toString(),
      sliUnit: targetUnit,
      errorBudgetRemaining: remaining.toString(),
      errorBudgetConsumed: consumed.toString(),
      sampleCount,
      metadata,
    })
    .returning({
      id: sloSnapshots.id,
      snapshotAt: sloSnapshots.snapshotAt,
    });
  const row = rows[0];
  if (!row) throw new Error("slo_snapshot_insert_failed");

  return {
    id: row.id as string,
    sloId,
    snapshotAt: row.snapshotAt,
    sliValue,
    sliUnit: targetUnit,
    errorBudgetRemaining: remaining,
    errorBudgetConsumed: consumed,
    sampleCount,
    metadata,
  };
}

/**
 * Get the SLOs that are currently alerting (error budget consumed > threshold).
 * Used by the status endpoint + the alert cron.
 */
export async function listAlertingSlos(): Promise<SloWithSnapshot[]> {
  const all = await listSlos();
  return all.filter((s) => s.alerting);
}
