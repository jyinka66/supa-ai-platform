/**
 * @supa/money/currency
 * ----------------------------------------------------------------
 * Workspace has an base currency (reporting currency). Transactions
 *   store their NATIVE currency + amount; conversion to base happens
 *   only in report queries, at the recorded rate (or explicit
 *   re-rate). Originals are always retrievable — "show originals"
 *   is not a mode, it's the model. A ₦-denominated invoice paid in
 *   ₦ records ₦; the revenue report converts to base at as-of rate;
 *   a hover on the report row shows both. No hidden conversions.
 * ----------------------------------------------------------------
 */

import type {
  Currency,
  Money,
  Rate,
} from "./money.js";
import { asCurrency, convert, zero } from "./money.js";

// ───────────────────────────────────────────────
// Workspace currency config
// ───────────────────────────────────────────────

/**
 * The workspace's base (reporting) currency. All report queries
 * convert to this currency. Native amounts are never lost — they're
 * always retrievable alongside the converted value.
 */
export interface WorkspaceCurrencyConfig {
  readonly workspaceId: string;
  /** The base (reporting) currency. */
  readonly baseCurrency: Currency;
  /**
   * Default rate source for report queries: 'manual' uses the latest
   * manually-entered rate; 'provider' uses the latest provider feed.
   * Either way, the rate is RECORDED on the report row — never ambient.
   */
  readonly defaultRateSource: "manual" | "provider";
}

// ───────────────────────────────────────────────
// Monetary fact — written once, never mutated
// ───────────────────────────────────────────────

/**
 * A monetary fact. The single source of truth for "an amount moved."
 *
 * THE RULE: a monetary fact is written exactly once, by exactly one
 * path, and never mutated — corrected by a new fact. Everything
 * else is a query.
 *
 * The fact stores:
 *   - nativeAmount: the amount in the currency the transaction
 *     actually occurred in (₦ invoice paid in ₦ → ₦).
 *   - nativeCurrency: the currency code.
 *   - recordedRate: the rate at which the fact was recorded (if it
 *     was converted at write time — e.g. a USD payment recorded
 *     against a ₦ workspace). Optional; facts in the workspace's
 *     base currency have no recordedRate.
 *   - asOf: when the fact occurred.
 *
 * The fact does NOT store a converted amount. Conversion happens
 * only in report queries, at the recorded rate (or explicit re-rate
 * for historical reports). This is the "show originals is not a
 * mode, it's the model" rule.
 */
export interface MonetaryFact {
  /** Stable id (ULID). */
  readonly id: string;
  readonly workspaceId: string;
  /** The native amount + currency. */
  readonly nativeAmount: Money;
  /**
   * The rate at which the fact was recorded, if the native currency
   * differs from the workspace's base currency. Optional — facts in
   * the base currency have no recordedRate (conversion is identity).
   */
  readonly recordedRate: Rate | undefined;
  /** When the fact occurred (ms epoch). */
  readonly asOf: number;
  /** What the fact represents — invoice, payment, expense, refund, etc. */
  readonly kind: FactKind;
  /** Reference to the source document (e.g. invoice id). */
  readonly sourceId: string;
}

export type FactKind =
  | "invoice-issued"
  | "invoice-paid"
  | "expense-recorded"
  | "refund-issued"
  | "tax-paid"
  | "transfer"
  | "adjustment";

// ───────────────────────────────────────────────
// Report query — converts to base currency at recorded rate
// ───────────────────────────────────────────────

export interface ReportRow {
  readonly factId: string;
  /** Native amount (always retrievable — "show originals" is the model). */
  readonly nativeAmount: Money;
  /** Converted amount in the workspace's base currency. */
  readonly baseAmount: Money;
  /** The rate used for this conversion (recorded on the row — never ambient). */
  readonly rateUsed: Rate | undefined;
  readonly asOf: number;
  readonly kind: FactKind;
  readonly sourceId: string;
}

/**
 * Run a report query over a set of monetary facts, converting each
 * to the workspace's base currency at the recorded rate (or explicit
 * re-rate).
 *
 * "No hidden conversions": every report row carries the rate it used.
 * A hover on the report row shows both native + base amounts.
 */
export function reportQuery(
  facts: ReadonlyArray<MonetaryFact>,
  config: WorkspaceCurrencyConfig,
  opts?: {
    /** Optional re-rate for facts without a recordedRate (e.g. historical report at today's rate). */
    reRate?: (fact: MonetaryFact) => Rate | undefined;
  },
): ReportRow[] {
  return facts.map((fact) => {
    // Same-currency → no conversion needed.
    if (fact.nativeAmount.currency === config.baseCurrency) {
      return {
        factId: fact.id,
        nativeAmount: fact.nativeAmount,
        baseAmount: fact.nativeAmount,
        rateUsed: undefined,
        asOf: fact.asOf,
        kind: fact.kind,
        sourceId: fact.sourceId,
      };
    }
    // Cross-currency → convert at recorded rate, or re-rate.
    const rate = fact.recordedRate ?? opts?.reRate?.(fact);
    if (!rate) {
      // No rate → can't convert. The row carries the native amount
      // and an explicit zero base amount + no rateUsed, so the report
      // surfaces the gap honestly (the caller can filter on this).
      return {
        factId: fact.id,
        nativeAmount: fact.nativeAmount,
        baseAmount: zero(config.baseCurrency),
        rateUsed: undefined,
        asOf: fact.asOf,
        kind: fact.kind,
        sourceId: fact.sourceId,
      };
    }
    const { converted } = convert(fact.nativeAmount, rate);
    return {
      factId: fact.id,
      nativeAmount: fact.nativeAmount,
      baseAmount: converted,
      rateUsed: rate,
      asOf: fact.asOf,
      kind: fact.kind,
      sourceId: fact.sourceId,
    };
  });
}

// ───────────────────────────────────────────────
// Fact construction — the single write path
// ───────────────────────────────────────────────

/**
 * The single path by which monetary facts are written. Every fact
 * goes through this constructor — there is no other entry point.
 *
 * The constructor enforces:
 *   - nativeAmount's currency matches recordedRate.from (if rate present)
 *   - recordedRate.to === base currency (if rate present)
 *   - asOf is present
 *   - sourceId is present
 *
 * Facts are immutable — to correct a fact, write a new fact with
 * kind="adjustment" referencing the original via sourceId.
 */
export function writeFact(
  workspaceId: string,
  fact: {
    nativeAmount: Money;
    recordedRate?: Rate | undefined;
    asOf: number;
    kind: FactKind;
    sourceId: string;
    id: string;
  },
  config: WorkspaceCurrencyConfig,
): MonetaryFact {
  // Validate rate consistency.
  if (fact.recordedRate) {
    if (fact.recordedRate.from !== fact.nativeAmount.currency) {
      throw new Error(
        `recordedRate.from (${fact.recordedRate.from}) must match nativeAmount.currency (${fact.nativeAmount.currency})`,
      );
    }
    if (fact.recordedRate.to !== config.baseCurrency) {
      throw new Error(
        `recordedRate.to (${fact.recordedRate.to}) must match base currency (${config.baseCurrency})`,
      );
    }
  }
  return {
    id: fact.id,
    workspaceId,
    nativeAmount: fact.nativeAmount,
    recordedRate: fact.recordedRate,
    asOf: fact.asOf,
    kind: fact.kind,
    sourceId: fact.sourceId,
  };
}

// ───────────────────────────────────────────────
// Workspace currency config helpers
// ───────────────────────────────────────────────

export function makeWorkspaceCurrencyConfig(
  workspaceId: string,
  baseCurrency: string,
  defaultRateSource: "manual" | "provider" = "manual",
): WorkspaceCurrencyConfig {
  return {
    workspaceId,
    baseCurrency: asCurrency(baseCurrency),
    defaultRateSource,
  };
}

// ───────────────────────────────────────────────
// "Show originals" — the model, not a mode
// ───────────────────────────────────────────────

/**
 * Every report row carries both the native amount AND the converted
 * base amount. "Show originals" is not a UI toggle — it's the data
 * model. This helper extracts the (native, base) pair for display.
 */
export function nativeAndBase(row: ReportRow): { native: Money; base: Money; rate?: Rate } {
  return {
    native: row.nativeAmount,
    base: row.baseAmount,
    ...(row.rateUsed !== undefined ? { rate: row.rateUsed } : {}),
  };
}

// ───────────────────────────────────────────────
// Re-export primitives for convenience
// ───────────────────────────────────────────────

export { fromMinor, zero } from "./money.js";
export type { Currency, Money, Rate } from "./money.js";
