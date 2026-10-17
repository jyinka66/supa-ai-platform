/**
 * @supa/deals — the CRM pipeline pass.
 *
 * A pipeline over the money spine. Deals carry Money values; stage
 * moves are activity facts (free analytics); weighted pipeline is
 * value × probability (honest numbers — the source of the probability
 * is shown on every deal card). Conversion to invoice closes the loop:
 * CRM feeds invoice, money facts flow back to CRM, fully-paid prompts
 * Won.
 *
 *   pipeline — Pipeline (stages as data, Won/Lost terminal), Deal
 *              entity, weighted value (value × probability), pipeline
 *              totals (cross-currency at as-of rates, no silent FX).
 *   kanban   — Drag discipline borrowed from design-editor (pointer
 *              state machine, transform-only moves, rAF batching,
 *              one-op drop commit). Long-press for touch, auto-scroll
 *              zones, 8px drop targets. Conflict: last-write-wins +
 *              activity fact. Offline: stage changes require connection.
 *   convert  — Deal → invoice draft. Payment facts write back activity
 *              on the deal. Fully-paid invoice prompts (not forces) Won.
 *
 * The anchor thesis: customer → deal → invoice → paid is literally
 * the data flow. No separate "revenue from CRM" report needed; it's
 * the same fact table filtered.
 */

export * from "./pipeline.js";
export * from "./kanban.js";
export * from "./convert.js";
