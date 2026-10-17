/**
 * @supa/observability — operability spine
 *
 * Five modules, each independently importable so a tree-shaking
 * consumer that only needs telemetry doesn't pull crash, ai-quality,
 * cost-model, or canary.
 *
 *   telemetry  — event spine (ops + session heartbeat)
 *   crash      — taxonomy + region boundaries + invariant bridge
 *   ai-quality — sampling, implicit KPIs, prompt benchmark gate
 *   cost-model — unit economics per tier + cost alerting thresholds
 *   canary     — 2% rollout policy + automated gate + auto-rollback
 *
 * The package is adjacent to @supa/app-shell and is imported nowhere
 * in product logic — the editor wires it; the warehouse consumes it.
 */

export * from "./telemetry.js";
export * from "./crash.js";
export * from "./ai-quality.js";
export * from "./cost-model.js";
export * from "./canary.js";
