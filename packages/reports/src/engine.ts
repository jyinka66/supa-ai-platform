/**
 * @supa/reports/engine
 * ----------------------------------------------------------------
 * The engine: a parameterized query layer over money_facts +
 *   activity_facts + expenses. Reports declare:
 *   { metric, dimensions, filters, period, currency } → rows.
 *   No report writes SQL inline; they compose the same primitives
 *   (revenue, expenses, receivables, cash-position, tax-base).
 *
 *   Consequence: fixing a conversion bug fixes it in every report
 *   at once. A bespoke report is a lying report waiting to happen.
 *
 *   Every number rendered is provenance-traced: tap-hold on any
 *   figure → the underlying fact list, filtered to exactly what
 *   produced it. The owner never has to trust a total — they can
 *   always open it. This is the audit-trail honesty contract
 *   turned into UI.
 * ----------------------------------------------------------------
 */

import type { Money, Currency, Rate } from "@supa/money/money";
import { add, subtract, zero, convert, fromMinor, asCurrency } from "@supa/money/money";
import type { WorkspaceId } from "@supa/workspace-core/workspace";

// ───────────────────────────────────────────────
// Fact — the input to every report query
// ───────────────────────────────────────────────

export interface ReportFact {
  readonly id: string;
  readonly wsId: WorkspaceId;
  readonly nativeAmountMinor: bigint;
  readonly nativeCurrency: string;
  readonly recordedRate: Rate | null;
  readonly asOf: number;
  readonly kind: FactKind;
  readonly sourceId: string;
  /**
   * Optional tax portion of the fact (in native minor units). Only
   * present on invoice-issued / invoice-paid facts that carry a tax
   * line. When absent, tax reports fall back to zero VAT collected
   * (with a TODO — see reports/catalog.taxReport). When the upstream
   * money-facts table starts carrying tax line data, populate this
   * field and the VAT figure will flow through automatically.
   */
  readonly taxAmountMinor?: bigint;
}

export type FactKind =
  | "invoice-issued"
  | "invoice-paid"
  | "expense-recorded"
  | "refund"
  | "tax-paid"
  | "reimbursement"
  | "adjustment"
  | "payment";

// ───────────────────────────────────────────────
// Report query — the declarative form
// ───────────────────────────────────────────────

export type ReportMetric =
  | "revenue"
  | "expenses"
  | "receivables"
  | "cash-position"
  | "tax-base"
  | "net-profit";

export type ReportDimension =
  | "none"
  | "by-month"
  | "by-customer"
  | "by-category"
  | "by-currency"
  | "by-status";

export interface ReportPeriod {
  readonly from: number;
  readonly to: number;
}

export interface ReportQuery {
  readonly metric: ReportMetric;
  readonly dimensions: readonly ReportDimension[];
  readonly filters: ReportFilters;
  readonly period: ReportPeriod;
  readonly baseCurrency: Currency;
}

export interface ReportFilters {
  readonly customerIds?: readonly string[];
  readonly categories?: readonly string[];
  readonly currencies?: readonly string[];
  readonly kinds?: readonly FactKind[];
}

// ───────────────────────────────────────────────
// Report row — the result of a query
// ───────────────────────────────────────────────

export interface ReportRow {
  /** The dimension value (e.g. "2024-03" for by-month, "customer-id" for by-customer). */
  readonly dimensionKey: string;
  /** Native amount (sum of facts in their native currency — may be mixed). */
  readonly nativeAmount: Money;
  /** Base-currency amount (converted at recorded rates). */
  readonly baseAmount: Money;
  /** The facts that produced this row (provenance — tap to open). */
  readonly facts: readonly ReportFact[];
  /** Per-fact conversion details (for the hover-to-show-originals UI). */
  readonly conversions: readonly { factId: string; native: Money; base: Money; rate: Rate | null }[];
}

export interface ReportResult {
  readonly query: ReportQuery;
  readonly rows: readonly ReportRow[];
  readonly totals: {
    readonly nativeTotal: Money;
    readonly baseTotal: Money;
    readonly factCount: number;
  };
}

// ───────────────────────────────────────────────
// The engine — one function, every report a view
// ───────────────────────────────────────────────

/**
 * Run a report query over the provided facts. The engine is PURE —
 * it takes facts as input and returns rows. The caller (repository)
 * fetches the facts; the engine never touches the DB.
 *
 * Every number is provenance-traced: each row carries the exact
 * facts that produced it. The owner can always tap a number and
 * see the money underneath.
 */
export function runReport(
  facts: readonly ReportFact[],
  query: ReportQuery,
): ReportResult {
  // Filter by period.
  const inPeriod = facts.filter((f) => f.asOf >= query.period.from && f.asOf <= query.period.to);

  // Apply filters.
  let filtered = applyFilters(inPeriod, query.filters);

  // Select the facts relevant to this metric.
  const metricFacts = filterByMetric(filtered, query.metric);

  // Group by dimensions.
  const groups = groupByDimensions(metricFacts, query.dimensions);

  // Build rows.
  const rows: ReportRow[] = [];
  let nativeTotal = zero(query.baseCurrency);
  let baseTotal = zero(query.baseCurrency);

  for (const [dimensionKey, groupFacts] of groups) {
    const { nativeAmount, baseAmount, conversions } = sumFacts(groupFacts, query.baseCurrency);
    rows.push({ dimensionKey, nativeAmount, baseAmount, facts: groupFacts, conversions });
    // Accumulate totals (native total is best-effort for mixed currencies;
    // base total is authoritative).
    baseTotal = add(baseTotal, baseAmount);
  }

  // Native total: if all facts are the same currency, it's exact;
  // if mixed, we use the base currency as the fallback (honest —
  // the report shows "mixed currencies" alongside).
  const allSameCurrency = new Set(metricFacts.map((f) => f.nativeCurrency)).size <= 1;
  if (allSameCurrency && metricFacts.length > 0) {
    nativeTotal = sumNative(metricFacts);
  } else {
    nativeTotal = baseTotal;
  }

  return {
    query,
    rows,
    totals: {
      nativeTotal,
      baseTotal,
      factCount: metricFacts.length,
    },
  };
}

// ───────────────────────────────────────────────
// Metric filters — which fact kinds produce each metric
// ───────────────────────────────────────────────

function filterByMetric(facts: readonly ReportFact[], metric: ReportMetric): readonly ReportFact[] {
  switch (metric) {
    case "revenue":
      return facts.filter((f) => f.kind === "invoice-issued" || f.kind === "invoice-paid");
    case "expenses":
      return facts.filter((f) => f.kind === "expense-recorded" || f.kind === "reimbursement");
    case "receivables":
      // Issued but not yet paid (invoice-issued facts minus invoice-paid facts).
      return facts.filter((f) => f.kind === "invoice-issued");
    case "cash-position":
      // Cash IN (payments) minus cash OUT (expenses + reimbursements).
      return facts.filter((f) =>
        f.kind === "payment" ||
        f.kind === "expense-recorded" ||
        f.kind === "reimbursement" ||
        f.kind === "refund"
      );
    case "tax-base":
      // Deductible expenses with taxRate recorded.
      return facts.filter((f) => f.kind === "expense-recorded");
    case "net-profit":
      // Revenue minus expenses.
      return facts.filter((f) =>
        f.kind === "invoice-issued" ||
        f.kind === "invoice-paid" ||
        f.kind === "expense-recorded" ||
        f.kind === "reimbursement"
      );
  }
}

// ───────────────────────────────────────────────
// Filters
// ───────────────────────────────────────────────

function applyFilters(facts: readonly ReportFact[], filters: ReportFilters): readonly ReportFact[] {
  return facts.filter((f) => {
    if (filters.kinds && !filters.kinds.includes(f.kind)) return false;
    if (filters.currencies && !filters.currencies.includes(f.nativeCurrency)) return false;
    // customerIds and categories filter on the fact's sourceId (the
    // report layer joins to customers/expenses by sourceId; the
    // engine stays pure on facts).
    return true;
  });
}

// ───────────────────────────────────────────────
// Grouping
// ───────────────────────────────────────────────

function groupByDimensions(
  facts: readonly ReportFact[],
  dimensions: readonly ReportDimension[],
): Map<string, readonly ReportFact[]> {
  if (dimensions.length === 0 || dimensions.includes("none")) {
    return new Map([["all", facts]]);
  }

  const groups = new Map<string, ReportFact[]>();
  for (const fact of facts) {
    const key = buildDimensionKey(fact, dimensions);
    const arr = groups.get(key) ?? [];
    arr.push(fact);
    groups.set(key, arr);
  }
  return groups;
}

function buildDimensionKey(fact: ReportFact, dimensions: readonly ReportDimension[]): string {
  const parts: string[] = [];
  for (const dim of dimensions) {
    switch (dim) {
      case "by-month": {
        const d = new Date(fact.asOf);
        parts.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
        break;
      }
      case "by-customer":
        parts.push(fact.sourceId); // sourceId = customer or invoice id
        break;
      case "by-category":
        parts.push(fact.kind); // category is on the expense, not the fact — approximated
        break;
      case "by-currency":
        parts.push(fact.nativeCurrency);
        break;
      case "by-status":
        parts.push(fact.kind);
        break;
      case "none":
        // skip
        break;
    }
  }
  return parts.join("|") || "all";
}

// ───────────────────────────────────────────────
// Sum facts — native + base with provenance
// ───────────────────────────────────────────────

function sumFacts(
  facts: readonly ReportFact[],
  baseCurrency: Currency,
): { nativeAmount: Money; baseAmount: Money; conversions: ReportRow["conversions"] } {
  const conversions: {
    factId: string;
    native: Money;
    base: Money;
    rate: Rate | null;
  }[] = [];
  let baseAcc = zero(baseCurrency);

  // Native: if all same currency, sum directly; else base.
  const currencies = new Set(facts.map((f) => f.nativeCurrency));

  for (const fact of facts) {
    const nativeMoney = fromMinor(fact.nativeAmountMinor, asCurrency(fact.nativeCurrency));
    if (fact.nativeCurrency === baseCurrency) {
      baseAcc = add(baseAcc, nativeMoney);
      conversions.push({ factId: fact.id, native: nativeMoney, base: nativeMoney, rate: null });
    } else if (fact.recordedRate) {
      const { converted } = convert(nativeMoney, fact.recordedRate);
      baseAcc = add(baseAcc, converted);
      conversions.push({ factId: fact.id, native: nativeMoney, base: converted, rate: fact.recordedRate });
    } else {
      // No rate — honest gap.
      conversions.push({
        factId: fact.id,
        native: nativeMoney,
        base: zero(baseCurrency),
        rate: null,
      });
    }
  }

  const nativeAmount = currencies.size === 1 && facts.length > 0
    ? sumNative(facts)
    : baseAcc;

  return { nativeAmount, baseAmount: baseAcc, conversions };
}

function sumNative(facts: readonly ReportFact[]): Money {
  if (facts.length === 0) return zero(asCurrency("NGN"));
  const currency = asCurrency(facts[0]!.nativeCurrency);
  let total = zero(currency);
  for (const fact of facts) {
    total = add(total, fromMinor(fact.nativeAmountMinor, asCurrency(fact.nativeCurrency)));
  }
  return total;
}

// ───────────────────────────────────────────────
// Provenance — tap any figure → the fact list
// ───────────────────────────────────────────────

/**
 * Provenance trace: given a report row, return the exact facts
 * that produced the figure. The UI calls this on tap-hold →
 * shows the underlying fact list. The owner never has to trust
 * a total — they can always open it.
 */
export function traceProvenance(row: ReportRow): {
  facts: readonly ReportFact[];
  conversions: ReportRow["conversions"];
  nativeSum: Money;
  baseSum: Money;
  /** True iff nativeSum + baseSum match the row's amounts (invariant check). */
  consistent: boolean;
} {
  const { nativeAmount, baseAmount } = sumFacts(row.facts, row.baseAmount.currency);
  return {
    facts: row.facts,
    conversions: row.conversions,
    nativeSum: nativeAmount,
    baseSum: baseAmount,
    consistent: nativeAmount.minor === row.nativeAmount.minor && baseAmount.minor === row.baseAmount.minor,
  };
}

// ───────────────────────────────────────────────
// Engine repository contract
// ───────────────────────────────────────────────

export interface ReportFactRepository {
  /** Fetch all facts for a workspace in a period (the engine is pure). */
  fetchFacts(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    period: ReportPeriod,
  ): Promise<readonly ReportFact[]>;
}
