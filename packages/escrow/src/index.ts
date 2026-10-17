/**
 * @supa/escrow — escrow + payout.
 *
 *   ledger    — Append-only double-entry ledger. No UPDATE, no DELETE —
 *               corrections are reversing entries. Idempotency keys
 *               prevent duplicate inserts. Balance is derived (never
 *               stored — the no-drift rule).
 *   release   — The milestone payout path. Three legs, one transaction,
 *               one idempotency family. Sum invariant asserted inside
 *               the tx before commit. Auto-release = same code path
 *               (scheduler-triggered, not parallel).
 *   payouts   — Money leaving the building. Available balance → bank
 *               transfer. Webhook handling: confirmations + failures
 *               consumed as facts. Duplicate webhooks no-op via
 *               idempotency keys. Failed payouts auto-reverse.
 *   reconcile — Daily three-way reconciliation: ledger self-check,
 *               ledger ↔ provider, ledger ↔ milestones. A clean day
 *               is a fact; a dirty day is a page.
 */

export * from "./ledger.js";
export * from "./release.js";
export * from "./payouts.js";
export * from "./reconcile.js";
