/**
 * @supa/money — the primitive money layer (no feature code, no
 * imports from features).
 *
 *   money    — Money{minor:bigint,currency}, same-currency
 *              arithmetic, Rate for cross-currency (explicit,
 *              timestamped, sourced), banker's rounding with explicit
 *              roundRemainder line so invoices always balance to the
 *              kobo. Property test invariant:
 *              Σ(lines) − Σ(discounts) + Σ(tax) + roundRemainder === total
 *   currency — workspace base currency, transactions store native +
 *              amount, conversion only in report queries at the
 *              recorded rate (or explicit re-rate). Originals always
 *              retrievable — "show originals" is not a mode, it's
 *              the model.
 *
 * THE RULE: a monetary fact is written exactly once, by exactly one
 * path, and never mutated — corrected by a new fact. Everything
 * else is a query.
 */

export * from "./money.js";
export * from "./currency.js";
