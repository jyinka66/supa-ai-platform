/**
 * @supa/reports/dashboard
 * ----------------------------------------------------------------
 * The dashboard is the app's front door and its hardest perf
 *   budget: 3 seconds from cold tap to interactive on the
 *   reference device (the mid-tier phone, throttled network).
 *
 *   Mechanics — the io-pass playbook, applied at UI scale:
 *   • Single batched request per paint; no report widget fires
 *     its own query (N+1 at the network layer is still N+1).
 *   • Materialized daily summaries (money_facts rolled up per
 *     workspace-day, maintained by the same event pipeline that
 *     writes activities — rollups are a cache with an invalidation
 *     rule, never a source of truth; every rollup is verifiable
 *     against the fact table, and a nightly recompute reconciles).
 *   • Paint order: skeleton with real layout (no CLS) → hero
 *     numbers first → charts stream in.
 *   • Cached last-view for instant reopen; staleness visibly
 *     marked ("as of 10:42") rather than silently fresh.
 * ----------------------------------------------------------------
 */

import type { Money, Currency } from "@supa/money/money";
import { add, subtract, zero } from "@supa/money/money";
import type { WorkspaceId } from "@supa/workspace-core/workspace";
import type { ReportFact, ReportPeriod } from "./engine.js";
import { runReport } from "./engine.js";

// ───────────────────────────────────────────────
// Dashboard data — the hero numbers + widgets
// ───────────────────────────────────────────────

export interface DashboardData {
  /** Hero numbers — the first thing the owner reads. */
  readonly hero: {
    /** Revenue this period (billed, not collected). */
    readonly revenue: Money;
    /** Expenses this period. */
    readonly expenses: Money;
    /** Net profit (revenue − expenses). */
    readonly netProfit: Money;
    /** Outstanding receivables (invoiced − collected). */
    readonly receivables: Money;
  };
  /** When the data was computed (for staleness display). */
  readonly computedAt: number;
  /** Whether the data is from cache (true) or fresh (false). */
  readonly fromCache: boolean;
  /** Period the dashboard covers. */
  readonly period: ReportPeriod;
}

// ───────────────────────────────────────────────
// Dashboard query — single batched request
// ───────────────────────────────────────────────

/**
 * Build the dashboard data from facts in a SINGLE pass. No widget
 * fires its own query — the dashboard computes all hero numbers
 * from the same fact list.
 *
 * The 3-second contract: this function runs on the server, the
 * result is a small JSON payload (4 Money values + metadata), the
 * client renders the skeleton + hero numbers from this payload.
 * Charts stream in separately (measured separately from the
 * 3-second budget).
 */
export function buildDashboard(
  facts: readonly ReportFact[],
  period: ReportPeriod,
  baseCurrency: Currency,
  now: number = Date.now(),
): DashboardData {
  const revenueResult = runReport(facts, {
    metric: "revenue",
    dimensions: ["none"],
    filters: { kinds: ["invoice-issued"] },
    period,
    baseCurrency,
  });
  const expensesResult = runReport(facts, {
    metric: "expenses",
    dimensions: ["none"],
    filters: { kinds: ["expense-recorded"] },
    period,
    baseCurrency,
  });
  const collectedResult = runReport(facts, {
    metric: "revenue",
    dimensions: ["none"],
    filters: { kinds: ["invoice-paid", "payment"] },
    period,
    baseCurrency,
  });

  const revenue = revenueResult.totals.baseTotal;
  const expenses = expensesResult.totals.baseTotal;
  const netProfit = subtract(revenue, expenses);
  const receivables = subtract(revenueResult.totals.baseTotal, collectedResult.totals.baseTotal);

  return {
    hero: { revenue, expenses, netProfit, receivables },
    computedAt: now,
    fromCache: false,
    period,
  };
}

// ───────────────────────────────────────────────
// Rollup — materialized daily summary (cache, not source of truth)
// ───────────────────────────────────────────────

export interface DailyRollup {
  readonly wsId: WorkspaceId;
  readonly day: number; // ms epoch, midnight UTC
  readonly revenueMinor: bigint;
  readonly expensesMinor: bigint;
  readonly currency: Currency;
}

/**
 * Build a daily rollup from facts. Rollups are a CACHE with an
 * invalidation rule — they're verifiable against the fact table,
 * and a nightly recompute reconciles.
 *
 * The dashboard uses rollups for instant-open (cached last-view).
 * The staleness is visibly marked ("as of 10:42") rather than
 * silently fresh. An honest stale number beats a lying fresh-feeling one.
 */
export function buildDailyRollup(
  facts: readonly ReportFact[],
  day: number,
  baseCurrency: Currency,
  wsId: WorkspaceId,
): DailyRollup | null {
  const startOfDay = Math.floor(day / 86_400_000) * 86_400_000;
  const endOfDay = startOfDay + 86_400_000;
  const dayFacts = facts.filter((f) => f.asOf >= startOfDay && f.asOf < endOfDay);

  const revenue = runReport(dayFacts, {
    metric: "revenue",
    dimensions: ["none"],
    filters: { kinds: ["invoice-issued"] },
    period: { from: startOfDay, to: endOfDay },
    baseCurrency,
  });
  const expenses = runReport(dayFacts, {
    metric: "expenses",
    dimensions: ["none"],
    filters: { kinds: ["expense-recorded"] },
    period: { from: startOfDay, to: endOfDay },
    baseCurrency,
  });

  return {
    wsId,
    day: startOfDay,
    revenueMinor: revenue.totals.baseTotal.minor,
    expensesMinor: expenses.totals.baseTotal.minor,
    currency: baseCurrency,
  };
}

/**
 * Verify a rollup against the fact table. Every rollup is
 * verifiable — if the rollup disagrees with the facts, the
 * nightly recompute reconciles (self-healing cache, provably).
 */
export function verifyRollup(
  rollup: DailyRollup,
  facts: readonly ReportFact[],
): { consistent: boolean; reason: string } {
  const recomputed = buildDailyRollup(
    facts,
    rollup.day,
    rollup.currency,
    rollup.wsId,
  );
  if (!recomputed) {
    return { consistent: false, reason: "no facts for this day" };
  }
  if (recomputed.revenueMinor !== rollup.revenueMinor) {
    return {
      consistent: false,
      reason: `revenue mismatch: rollup=${rollup.revenueMinor}, recomputed=${recomputed.revenueMinor}`,
    };
  }
  if (recomputed.expensesMinor !== rollup.expensesMinor) {
    return {
      consistent: false,
      reason: `expenses mismatch: rollup=${rollup.expensesMinor}, recomputed=${recomputed.expensesMinor}`,
    };
  }
  return { consistent: true, reason: "rollup matches facts" };
}

// ───────────────────────────────────────────────
// Cached last-view — instant reopen with staleness
// ───────────────────────────────────────────────

export interface CachedDashboard {
  readonly data: DashboardData;
  /** When the cache was written. */
  readonly cachedAt: number;
  /** "as of HH:MM" display string. */
  readonly stalenessLabel: string;
}

/**
 * Wrap a fresh dashboard in a cache entry. The UI shows the
 * staleness label ("as of 10:42") rather than silently presenting
 * stale data as fresh. An honest stale number beats a lying
 * fresh-feeling one.
 */
export function cacheDashboard(
  data: DashboardData,
  cachedAt: number,
): CachedDashboard {
  const d = new Date(cachedAt);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return {
    data: { ...data, fromCache: true },
    cachedAt,
    stalenessLabel: `as of ${hh}:${mm}`,
  };
}
