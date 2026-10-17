/**
 * @supa/freelance-core — the freelance management module.
 *
 * Sits on top of the money spine (@supa/money) + CRM
 * (@supa/customers). A job is a piece of work with a budget,
 * a deadline, a client (reuses the customer record), and a
 * status lifecycle.
 *
 *   job      — Zod schemas for the wire format (validation at the
 *              API boundary) + status transitions (same discipline as
 *              invoices/expenses) + wire↔domain Money conversion.
 *   boundary — External-platform isolation invariant. Runtime guard
 *              at write time + CI lint contract (no platform fetch).
 *   store    — Thin store over the spine's fact pipeline. Job
 *              transitions are activity_facts — timeline, AI summaries,
 *              and reports see freelance work for free.
 *
 * Sprint 1 starting point.
 */

export * from "./job.js";
export * from "./boundary.js";
export * from "./store.js";
