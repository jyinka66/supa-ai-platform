/**
 * @supa/reports/reports/catalog
 * ----------------------------------------------------------------
 * The report catalog. Every report is a view over the same engine
 * primitives. No report writes SQL inline — they compose the same
 * query engine.
 *
 *   Revenue          — invoiced vs collected (the gap IS the story)
 *   Expenses         — by category, by period, deductible split
 *   P&L              — revenue − expenses per period; margin first-class
 *   Cash flow        — money IN minus money OUT by settlement dates
 *   Receivables aging — current, 30/60/90+ buckets, per customer
 *   Tax              — deductible base × recorded taxRate, per period
 *   Comparisons      — any period vs prior / same last year / custom
 *   Custom           — metric + dimension + filter picker, saved per ws
 * ----------------------------------------------------------------
 */

import type { Currency } from "@supa/money/money";
import {
  runReport,
  type ReportFact,
  type ReportQuery,
  type ReportResult,
  type ReportPeriod,
} from "../engine.js";
import { computeDelta } from "../money.js";

// ───────────────────────────────────────────────
// Revenue report — invoiced vs collected
// ───────────────────────────────────────────────

export interface RevenueReport {
  readonly invoiced: ReportResult;
  readonly collected: ReportResult;
  /** The gap IS the story — outstanding receivables. */
  readonly outstanding: { native: bigint; base: bigint; currency: Currency };
}

export function revenueReport(
  facts: readonly ReportFact[],
  period: ReportPeriod,
  baseCurrency: Currency,
): RevenueReport {
  const invoiced = runReport(facts, {
    metric: "revenue",
    dimensions: ["by-month"],
    filters: { kinds: ["invoice-issued"] },
    period,
    baseCurrency,
  });
  const collected = runReport(facts, {
    metric: "revenue",
    dimensions: ["by-month"],
    filters: { kinds: ["invoice-paid", "payment"] },
    period,
    baseCurrency,
  });
  // Outstanding = invoiced − collected (the gap).
  const outstanding = {
    native: invoiced.totals.nativeTotal.minor - collected.totals.nativeTotal.minor,
    base: invoiced.totals.baseTotal.minor - collected.totals.baseTotal.minor,
    currency: baseCurrency,
  };
  return { invoiced, collected, outstanding };
}

// ───────────────────────────────────────────────
// P&L — revenue − expenses per period
// ───────────────────────────────────────────────

export interface PnLReport {
  readonly revenue: ReportResult;
  readonly expenses: ReportResult;
  readonly netProfit: { base: bigint; currency: Currency };
  readonly margin: number | null; // netProfit / revenue, or null if revenue=0
}

export function pnlReport(
  facts: readonly ReportFact[],
  period: ReportPeriod,
  baseCurrency: Currency,
): PnLReport {
  const revenue = runReport(facts, {
    metric: "revenue",
    dimensions: ["by-month"],
    filters: { kinds: ["invoice-issued"] },
    period,
    baseCurrency,
  });
  const expenses = runReport(facts, {
    metric: "expenses",
    dimensions: ["by-month"],
    filters: { kinds: ["expense-recorded"] },
    period,
    baseCurrency,
  });
  const netProfitBase = revenue.totals.baseTotal.minor - expenses.totals.baseTotal.minor;
  const margin = revenue.totals.baseTotal.minor === 0n
    ? null
    : Number((netProfitBase * 10000n) / revenue.totals.baseTotal.minor) / 100;
  return { revenue, expenses, netProfit: { base: netProfitBase, currency: baseCurrency }, margin };
}

// ───────────────────────────────────────────────
// Cash flow — money IN minus money OUT by settlement dates
// ───────────────────────────────────────────────

export interface CashFlowReport {
  readonly cashIn: ReportResult;
  readonly cashOut: ReportResult;
  readonly netCash: { base: bigint; currency: Currency };
}

export function cashFlowReport(
  facts: readonly ReportFact[],
  period: ReportPeriod,
  baseCurrency: Currency,
): CashFlowReport {
  const cashIn = runReport(facts, {
    metric: "cash-position",
    dimensions: ["by-month"],
    filters: { kinds: ["payment", "invoice-paid"] },
    period,
    baseCurrency,
  });
  const cashOut = runReport(facts, {
    metric: "cash-position",
    dimensions: ["by-month"],
    filters: { kinds: ["expense-recorded", "reimbursement", "refund"] },
    period,
    baseCurrency,
  });
  const netCash = cashIn.totals.baseTotal.minor - cashOut.totals.baseTotal.minor;
  return { cashIn, cashOut, netCash: { base: netCash, currency: baseCurrency } };
}

// ───────────────────────────────────────────────
// Receivables aging — current, 30/60/90+ buckets
// ───────────────────────────────────────────────

export interface ReceivablesAgingReport {
  readonly buckets: {
    current: { amount: bigint; count: number };
    days30: { amount: bigint; count: number };
    days60: { amount: bigint; count: number };
    days90plus: { amount: bigint; count: number };
  };
  readonly currency: Currency;
}

export function receivablesAgingReport(
  facts: readonly ReportFact[],
  asOfDate: number,
  baseCurrency: Currency,
): ReceivablesAgingReport {
  const DAY = 86_400_000;
  const invoicedFacts = facts.filter((f) => f.kind === "invoice-issued");
  const paidFacts = facts.filter((f) => f.kind === "invoice-paid" || f.kind === "payment");

  // Compute outstanding per invoice (issued minus paid).
  const byInvoice = new Map<string, bigint>();
  for (const f of invoicedFacts) {
    byInvoice.set(f.sourceId, (byInvoice.get(f.sourceId) ?? 0n) + f.nativeAmountMinor);
  }
  for (const f of paidFacts) {
    byInvoice.set(f.sourceId, (byInvoice.get(f.sourceId) ?? 0n) - f.nativeAmountMinor);
  }

  const buckets = {
    current: { amount: 0n, count: 0 },
    days30: { amount: 0n, count: 0 },
    days60: { amount: 0n, count: 0 },
    days90plus: { amount: 0n, count: 0 },
  };

  for (const [invoiceId, outstanding] of byInvoice) {
    if (outstanding <= 0n) continue; // paid or overpaid
    const issuedFact = invoicedFacts.find((f) => f.sourceId === invoiceId);
    if (!issuedFact) continue;
    const ageDays = Math.floor((asOfDate - issuedFact.asOf) / DAY);
    if (ageDays <= 30) {
      buckets.current.amount += outstanding;
      buckets.current.count++;
    } else if (ageDays <= 60) {
      buckets.days30.amount += outstanding;
      buckets.days30.count++;
    } else if (ageDays <= 90) {
      buckets.days60.amount += outstanding;
      buckets.days60.count++;
    } else {
      buckets.days90plus.amount += outstanding;
      buckets.days90plus.count++;
    }
  }

  return { buckets, currency: baseCurrency };
}

// ───────────────────────────────────────────────
// Tax report — deductible base × recorded taxRate
// ───────────────────────────────────────────────

export interface TaxReport {
  readonly deductibleExpenses: ReportResult;
  readonly vatCollected: { base: bigint; currency: Currency };
  readonly taxBase: { base: bigint; currency: Currency };
  readonly period: ReportPeriod;
}

export function taxReport(
  facts: readonly ReportFact[],
  period: ReportPeriod,
  baseCurrency: Currency,
): TaxReport {
  const deductibleExpenses = runReport(facts, {
    metric: "tax-base",
    dimensions: ["by-category"],
    filters: { kinds: ["expense-recorded"] },
    period,
    baseCurrency,
  });
  // VAT collected: sum the tax portion of every invoice-issued fact
  // whose `asOf` falls inside the report period. Facts that don't
  // carry tax line data (taxAmountMinor unset) contribute zero to
  // the sum, so the figure degrades to 0n gracefully when the
  // upstream money-facts table doesn't populate it yet.
  //
  // TODO(tax-facts): once the money-facts writer populates
  // `ReportFact.taxAmountMinor` from the invoice's tax breakdown
  // (see @supa/money.computeInvoiceTotals), the VAT figure here
  // will be exact. Until then this is a lower bound — the true VAT
  // collected is at least the sum of explicitly-recorded tax lines.
  const invoiceIssuedFacts = facts.filter(
    (f) =>
      f.kind === "invoice-issued" &&
      f.asOf >= period.from &&
      f.asOf <= period.to,
  );
  let vatBase = 0n;
  for (const f of invoiceIssuedFacts) {
    if (typeof f.taxAmountMinor === "bigint") {
      vatBase += f.taxAmountMinor;
    }
  }
  const vatCollected = { base: vatBase, currency: baseCurrency };
  const taxBase = {
    base: deductibleExpenses.totals.baseTotal.minor,
    currency: baseCurrency,
  };
  return { deductibleExpenses, vatCollected, taxBase, period };
}

// ───────────────────────────────────────────────
// Comparisons — period vs prior period
// ───────────────────────────────────────────────

export interface ComparisonReport {
  readonly current: ReportResult;
  readonly prior: ReportResult;
  readonly delta: {
    absolute: bigint;
    percentage: number | null;
    display: string;
  };
}

export function comparisonReport(
  facts: readonly ReportFact[],
  currentPeriod: ReportPeriod,
  priorPeriod: ReportPeriod,
  baseCurrency: Currency,
  metric: ReportQuery["metric"] = "revenue",
): ComparisonReport {
  const current = runReport(facts, {
    metric,
    dimensions: ["none"],
    filters: {},
    period: currentPeriod,
    baseCurrency,
  });
  const prior = runReport(facts, {
    metric,
    dimensions: ["none"],
    filters: {},
    period: priorPeriod,
    baseCurrency,
  });
  const delta = computeDelta(current.totals.baseTotal, prior.totals.baseTotal);
  return {
    current,
    prior,
    delta: {
      absolute: delta.absolute.minor,
      percentage: delta.percentage,
      display: delta.display,
    },
  };
}

// ───────────────────────────────────────────────
// Custom report — metric + dimension + filter picker
// ───────────────────────────────────────────────

export interface CustomReportConfig {
  readonly metric: ReportQuery["metric"];
  readonly dimensions: ReportQuery["dimensions"];
  readonly filters: ReportQuery["filters"];
  /** Saved per workspace. */
  readonly name: string;
  readonly id: string;
}

export function customReport(
  facts: readonly ReportFact[],
  config: CustomReportConfig,
  period: ReportPeriod,
  baseCurrency: Currency,
): ReportResult {
  return runReport(facts, {
    metric: config.metric,
    dimensions: config.dimensions,
    filters: config.filters,
    period,
    baseCurrency,
  });
}

// ───────────────────────────────────────────────
// Provenance — tap any figure → fact list
// ───────────────────────────────────────────────

export { traceProvenance } from "../engine.js";
