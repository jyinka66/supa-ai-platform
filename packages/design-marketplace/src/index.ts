/**
 * @supa/design-marketplace — template packaging, publish gate, discovery.
 *
 *   template-package — versioned, content-addressed package. Install
 *                      = fork + validate (op invariants re-run server-
 *                      side; template is untrusted input, same funnel
 *                      as user ops). Updates are diffs applied as ops.
 *   publish          — quality gauntlet (tokens/a11y/perf/fonts/compat/
 *                      provenance). Semver: MAJOR on token removed or
 *                      repurposed (re-theme of installed doc changes
 *                      meaning). Human review sampling-based on top.
 *   discovery        — search index. Remix as primary verb (remixes
 *                      rank, not installs — usefulness, not downloads).
 *                      Personalization on-device only; doc content
 *                      never leaves client for ranking.
 *   gates            — real gate impls wiring publish.ts contracts to
 *                      design-tokens check functions (no literals,
 *                      contrast per variant, perf budget, font license,
 *                      op-schema compat, AI provenance declaration).
 */

export * from "./template-package.js";
export * from "./publish.js";
export * from "./discovery.js";
export * from "./gates.js";
