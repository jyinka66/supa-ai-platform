/**
 * @supa/customers — the CRM pass.
 *
 * A relationship view over the money spine. A customer without
 * facts is a contact; a customer with facts is a business
 * relationship. Every "insight" must be a query over money_facts
 * or activity facts — never a cached field that can rot.
 *
 *   customer    — the record, deliberately small. Identity + facts
 *                 + timeline. NO derived fields (LTV/balance/
 *                 lastInvoice are QUERIES, not stored). Soft
 *                 archive, never delete.
 *   activity   — activity_facts, append-only. System facts
 *                 immutable (mirror money_facts); manual notes
 *                 editable 24h then frozen. Invoice/payment events
 *                 auto-fan-out — one timeline, two sources, zero
 *                 double-entry.
 *   duplicates  — detection at create + nightly batch. Normalized
 *                 phone/email + fuzzy name (RTL/i18n-aware). Merge
 *                 = a FACT, not a destructive edit. Reversible 30d,
 *                 auditable forever.
 *   import      — CSV import = io-pass honesty contract. Column
 *                 mapping with live preview, every guessed mapping
 *                 shown, every skipped row reported with reason,
 *                 duplicates flagged. Batch id = undo unit; no
 *                 partial mystery state.
 *
 * THE RULE: a customer record is identity + facts + timeline.
 * Nothing derived is ever stored.
 */

export * from "./customer.js";
export * from "./activity.js";
export * from "./duplicates.js";
export * from "./import.js";
