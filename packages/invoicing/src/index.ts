/**
 * @supa/invoicing — the anchor feature for the money spine.
 *
 *   numbering   — the one truly concurrent problem. Atomic DB-level
 *                 allocation via INSERT ... ON CONFLICT ... RETURNING.
 *                 Drafts don't consume numbers; allocate at first
 *                 send (draft → issued). Counter never decreases;
 *                 credit notes get their own CN- sequence.
 *   invoice     — Invoice entity + lifecycle (draft → issued →
 *                 partial → paid → voided). Void-not-delete:
 *                 money documents never vanish, they acquire a status.
 *   credit-note — separate CN- sequence. Offsets invoices without
 *                 decrementing the invoice counter. Net revenue =
 *                 Σ(invoices) − Σ(credit-notes).
 *
 * The rule: a monetary fact is written exactly once, by exactly one
 * path, and never mutated. Invoices are facts; credit notes are
 * facts; the numbering allocator is the single concurrent path.
 */

export * from "./numbering.js";
export * from "./invoice.js";
export * from "./credit-note.js";
