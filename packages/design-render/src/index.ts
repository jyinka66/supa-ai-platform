// @supa/design-render — scene graph → SVG rendering (Phase 5)
//
// Exports:
//   - transform: geometry (matrices, hit testing, AABB)
//   - measure: text measurement (Canvas + fontkit parity)
//   - render: scene graph → SVG string (pure, deterministic)

export * from "./transform";
export * from "./measure";
export { hitTest } from "./hittest";
export { renderPage, type RenderOpts, type RenderResult } from "./render";
export { RenderCache, type TextLayoutResult } from "./render-cache";
export {
  assertDeterministic,
  fuzzDeterministic,
  assertParity,
  assertRtlParity,
  RTL_CANARY_CORPUS,
  type ParityResult,
} from "./golden";
