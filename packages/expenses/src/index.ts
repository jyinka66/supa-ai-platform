/**
 * @supa/expenses — the expenses pass.
 *
 * Same money-spine discipline as invoicing: native currency is
 * truth, status is a state machine with transitions as facts,
 * 'recorded' is durable, 'draft' costs nothing. Multi-currency
 * rules are identical — one shared conversion module, zero
 * per-feature FX logic.
 *
 *   expense   — Expense record (native currency, per-workspace
 *               categories, taxDeductible + recorded taxRate,
 *               status state machine, paidBy).
 *   receipts  — Content-addressed store (same bytes = one blob).
 *               EXIF stripped (receipt photo can carry GPS),
 *               decode caps + sanitization, offline draft +
 *               queued upload.
 *   ocr       — Propose, never write. Confidence per field,
 *               confirmation UI is the only path into the record.
 *               Attributable metadata (modelVersion) for debugging.
 *   recurring — Shared scheduler pattern (one scheduler, two
 *               consumers: invoices + expenses). Idempotent per
 *               period key — server restart never double-charges.
 *   mileage   — Distance × rate → Money at entry time, recorded
 *               rate. GPS is convenience, never background tracker.
 *   approval  — Team-only flow (solo workspaces never see it).
 *               Transitions as activity facts — timeline is
 *               complete without a separate audit log.
 */

export * from "./expense.js";
export * from "./receipts.js";
export * from "./ocr.js";
export * from "./recurring.js";
export * from "./mileage.js";
export * from "./approval.js";
