import type { InlineTextState } from "./useInlineText";

/** The absolutely positioned contenteditable editor over the canvas text node. */
export function InlineTextEditor({ state }: InlineTextEditorProps) {
  if (!state.nodeId) return null;

  return (
    <div
      ref={state.editorRef}
      contentEditable
      suppressContentEditableWarning
      className="absolute outline-none border border-blue-400 bg-white/80 dark:bg-neutral-900/80"
      style={{
        ...state.style,
        left: state.rect.x,
        top: state.rect.y,
        width: state.rect.width,
        minHeight: state.rect.height,
        position: "absolute",
        zIndex: 100,
        padding: "0",
        margin: "0",
        overflow: "hidden",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
      onInput={state.handlers.onInput}
      onBlur={state.handlers.onBlur}
      onKeyDown={state.handlers.onKeyDown}
      onCompositionStart={state.handlers.onCompositionStart}
      onCompositionEnd={state.handlers.onCompositionEnd}
    />
  );
}
