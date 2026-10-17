/**
 * @supa/design-tokens — theme-token system made real across
 * templates, codegen, and AI.
 *
 *   schema           — Token model: id/type/value/variants/provenance.
 *                      Refs → primitives at leaf; cycle detection at
 *                      write time. 3-layer namespacing merge.
 *   bindings         — Token-to-doc binding. Template publish rule
 *                      (literals fail). Extract-to-token batch op.
 *                      Diff-and-suggest linter. Re-theme = ops.
 *   variants         — Theme modes (light/dark/contrast-high) as
 *                      render params, not doc copies. WCAG contrast
 *                      lint per variant.
 *   codegen          — Emit tokens as CSS custom properties.
 *                      Variants as @media queries. W3C DTCG
 *                      round-trip import/export.
 *   ai-integration   — AI palette generation emits token proposals
 *                      (not raw fills). Per-token accept. Undo-rate
 *                      KPI bridge to @supa/observability/ai-quality.
 */

export * from "./schema.js";
export * from "./bindings.js";
export * from "./variants.js";
export * from "./codegen.js";
export * from "./ai-integration.js";
