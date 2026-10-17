/**
 * @supa/reports — the report pass. The spine pays rent.
 *
 * A report is not a feature; it's a query the spine either answers
 * instantly or honestly admits it can't. Everything before this pass
 * was discipline so this pass could be simple.
 *
 *   engine      — one query engine, every report a view. Provenance-
 *                 traced: tap any figure → the underlying facts.
 *   money       — FX honesty: as-of semantics, recorded rates,
 *                 reproducible reports. No live FX, no moving targets.
 *   dashboard   — 3-second contract: batched request, materialized
 *                 rollups (verifiable cache), paint order, staleness
 *                 visibly marked.
 *   schedule    — scheduled reports (monthly revenue → email/WhatsApp).
 *                 Shared scheduler (third consumer).
 *   ai-summary  — AI month summary: numbers extracted by code, model
 *                 only chooses which to mention. Hallucinated numbers
 *                 are the one failure the whole spine prevents.
 *
 * THE RULE: every number on screen must trace to facts, convert
 * honestly, and render inside the budget — or the report says so
 * out loud.
 */

export * from "./engine.js";
export * from "./money.js";
export * from "./reports/catalog.js";
export * from "./dashboard.js";
export * from "./schedule.js";
export * from "./ai-summary.js";
