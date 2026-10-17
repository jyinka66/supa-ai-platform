/**
 * @supa/freelance-ai — global production autonomous work.
 *
 * 15 modules covering the full autonomous freelance lifecycle:
 *
 *   verbs        — Verb registry + draft lifecycle + quality signal.
 *   capture      — Doc/email/voice → structured job draft.
 *   proposal     — Listing + profile → cover letter draft.
 *   milestones   — Contract → milestone split (sum validated).
 *   brief        — Long brief → structured summary.
 *   agent        — Chains verbs into workflows (human in loop).
 *   quality-loop — Automated quality gate: flags bad (model, prompt) pairs.
 *   comms        — Client communication: progress updates, clarifications.
 *   delivery     — Work-delivery AI: code/copy/design drafts per discipline.
 *   pricing      — Rate suggestions based on market + history + budget.
 *   market       — Forward-looking demand signals + opportunity matching.
 *   auto-bid     — Autonomous proposal submission with hard guardrails.
 *   quality      — AI scorecard: accept rate, edit distance, downstream
 *                  outcome, cost per accepted draft. A/B traffic splitter.
 *   guardrails   — Injection screen, PII policy, no-fabrication guard,
 *                  rate limits. Every verb output passes all 4 before storage.
 */

export * from "./verbs.js";
export * from "./capture.js";
export * from "./proposal.js";
export * from "./milestones.js";
export * from "./brief.js";
export * from "./agent.js";
export * from "./quality-loop.js";
export * from "./comms.js";
export * from "./delivery.js";
export * from "./pricing.js";
export * from "./market.js";
export * from "./auto-bid.js";
export * from "./quality.js";
export * from "./guardrails.js";
