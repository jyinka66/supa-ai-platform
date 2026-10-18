// @supa/design-editor — the design editor web app (Phase 7)
//
// Exports:
//   - store: EditorStore (single source of truth + history)
//   - pointer: PointerController (state machine for canvas interaction)
//   - canvas: EditorCanvas (SVG canvas + overlay layer)

export { EditorStore, type EditorState, type OpenTransaction, type Tool } from "./store";
export {
  PointerController,
  screenToPage,
  pageToScreen,
  type PointerState,
  type PointerPayload,
  type PointerEvent,
  type WheelEvent,
  type Point,
  type Vec2,
  type HandleId,
  type ResizeHandle,
} from "./pointer";
export { EditorCanvas, OverlayLayer } from "./EditorCanvas";
export { useInlineText, type InlineTextState } from "./useInlineText";
export { InlineTextEditor } from "./InlineTextEditor";
export { Inspector } from "./inspector";
export { LayersPanel } from "./LayersPanel";
export { BindPanel } from "./BindPanel";
export {
  COMMANDS,
  KEYMAP,
  handleKeyDown,
  getEnabledCommands,
  searchCommands,
  type Command,
  type KeyBinding,
} from "./commands";
