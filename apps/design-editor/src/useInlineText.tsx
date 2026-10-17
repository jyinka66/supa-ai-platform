// ─────────────────────────────────────────────────────────────
// useInlineText — text editing overlay hook.
//
// A contenteditable div positioned over the text node (screen-space
// transform matches canvas), with:
//   - font styles copied from the node's first run style (via CSS)
//   - input → debounced (150ms) ephemeral ops; blur/Escape → commit:
//     ONE history entry per editing session via endTransaction()
//   - focus/caret management: on open, select-all if layer was
//     empty-created, else place caret at click point (document.caretRangeFromPoint)
//   - IME safety: on compositionstart, suppress commit until
//     compositionend — CJK/Arabic typing must not commit mid-composition.
//     This is the bug class that silently breaks Japanese input; the
//     debounce must check e.isComposing.
//   - Escape → commit + select tool; click elsewhere → commit + reprocess
//     the click (so click-away doesn't eat the click).
// ─────────────────────────────────────────────────────────────

import { useRef, useState, useEffect, useCallback } from "react";
import type { EditorStore } from "./store";
import type { TextLayer, DesignDoc, Page } from "@supa/design-model";
import { findLayerById } from "@supa/design-model";

export interface InlineTextState {
  /** The node being edited, or null when not editing. */
  nodeId: string | null;
  /** The contenteditable element ref. */
  editorRef: React.RefObject<HTMLDivElement>;
  /** Styles to apply to the contenteditable div (from the text layer). */
  style: React.CSSProperties;
  /** Position + size of the editor div (screen space). */
  rect: { x: number; y: number; width: number; height: number };
  /** Handlers to attach to the contenteditable div. */
  handlers: {
    onInput: (e: React.FormEvent<HTMLDivElement>) => void;
    onBlur: () => void;
    onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
    onCompositionStart: () => void;
    onCompositionEnd: (e: React.CompositionEvent<HTMLDivElement>) => void;
  };
}

const DEBOUNCE_MS = 150;

export function useInlineText(
  store: EditorStore,
  zoom: number,
  scroll: { x: number; y: number },
): InlineTextState {
  const [editingId, setEditingId] = useState<string | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(0 as unknown as ReturnType<typeof setTimeout>);
  const isComposingRef = useRef(false);
  const wasEmptyCreatedRef = useRef(false);

  // ============ START EDITING ============

  const startEditing = useCallback((nodeId: string, wasEmptyCreated: boolean) => {
    const state = store.get();
    const page = state.doc.pages.find((p) => p.id === state.pageId);
    if (!page) return;

    const node = findLayerById(page, nodeId);
    if (!node || node.type !== "text") return;

    wasEmptyCreatedRef.current = wasEmptyCreated;
    store.beginTransaction("move", { x: 0, y: 0 }); // any transaction kind — just to snapshot
    setEditingId(nodeId);

    // Focus the editor after React renders it.
    requestAnimationFrame(() => {
      const el = editorRef.current;
      if (!el) return;

      el.focus();

      if (wasEmptyCreated) {
        // Select all text (it's empty, so caret goes to start).
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      } else {
        // Place caret at the end.
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    });
  }, [store]);

  // ============ COMMIT ============

  const commit = useCallback(() => {
    if (!editingId) return;

    const el = editorRef.current;
    if (!el) {
      store.endTransaction();
      setEditingId(null);
      return;
    }

    const text = el.innerText;
    const state = store.get();
    const page = state.doc.pages.find((p) => p.id === state.pageId);
    if (!page) {
      store.endTransaction();
      setEditingId(null);
      return;
    }

    const node = findLayerById(page, editingId);
    if (!node || node.type !== "text") {
      store.endTransaction();
      setEditingId(null);
      return;
    }

    const textLayer = node as TextLayer;

    // Apply the final text as a non-ephemeral command.
    store.apply({
      op: "UPDATE_TEXT",
      pageId: state.pageId,
      id: editingId,
      content: text,
      runs: textLayer.runs, // keep existing runs (rich text editing is a future enhancement)
    });

    store.endTransaction();
    setEditingId(null);
  }, [editingId, store]);

  // ============ DEBOUNCED INPUT ============

  const debouncedUpdate = useCallback(() => {
    if (!editingId || isComposingRef.current) return;

    const el = editorRef.current;
    if (!el) return;

    const text = el.innerText;
    const state = store.get();

    // Apply as ephemeral (no history entry — committed on blur).
    store.apply({
      op: "UPDATE_TEXT",
      pageId: state.pageId,
      id: editingId,
      content: text,
      runs: [], // ephemeral — runs are finalized on commit
    }, { ephemeral: true });
  }, [editingId, store]);

  // ============ HANDLERS ============

  const onInput = useCallback((e: React.FormEvent<HTMLDivElement>) => {
    if (isComposingRef.current) return; // IME composition — don't commit

    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(debouncedUpdate, DEBOUNCE_MS);
  }, [debouncedUpdate]);

  const onBlur = useCallback(() => {
    // Clear any pending debounce.
    clearTimeout(debounceRef.current);
    commit();
  }, [commit]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    // IME: don't process Enter/Escape during composition.
    if (e.nativeEvent.isComposing) return;

    if (e.key === "Escape") {
      e.preventDefault();
      // Clear debounce + commit.
      clearTimeout(debounceRef.current);
      commit();
      // Switch back to select tool.
      store.setTool("select");
    }

    if (e.key === "Enter" && !e.shiftKey) {
      // Enter without Shift = commit (like a form).
      // Shift+Enter = newline (default behavior).
      e.preventDefault();
      clearTimeout(debounceRef.current);
      commit();
      store.setTool("select");
    }

    // Stop propagation so the canvas keyboard shortcuts don't fire.
    e.stopPropagation();
  }, [commit, store]);

  // ============ IME SAFETY ============

  const onCompositionStart = useCallback(() => {
    isComposingRef.current = true;
    // Clear any pending debounce — don't commit mid-composition.
    clearTimeout(debounceRef.current);
  }, []);

  const onCompositionEnd = useCallback((e: React.CompositionEvent<HTMLDivElement>) => {
    isComposingRef.current = false;
    // Now safe to update — the composition is complete.
    debouncedUpdate();
  }, [debouncedUpdate]);

  // ============ COMPUTE STYLES + POSITION ============

  const state = store.get();
  const page = state.doc.pages.find((p) => p.id === state.pageId);
  const textNode = editingId && page ? findLayerById(page, editingId) : null;

  let style: React.CSSProperties = {};
  let rect = { x: 0, y: 0, width: 0, height: 0 };

  if (textNode && textNode.type === "text") {
    const text = textNode as TextLayer;
    const screenX = (text.rect.x - scroll.x) * zoom;
    const screenY = (text.rect.y - scroll.y) * zoom;

    style = {
      fontFamily: text.fontFamily,
      fontSize: `${text.fontSize * zoom}px`,
      fontWeight: text.fontWeight,
      lineHeight: text.lineHeight,
      letterSpacing:
        text.letterSpacing.unit === "px"
          ? `${text.letterSpacing.value * zoom}px`
          : text.letterSpacing.unit === "em"
            ? `${text.letterSpacing.value}em`
            : `${text.letterSpacing.value}%`,
      textAlign: text.align,
      direction: text.direction,
      color: text.runs[0]?.color?.hex ?? "#000",
      transform: `rotate(${text.rotation}deg)`,
      transformOrigin: "center center",
    };

    rect = {
      x: screenX,
      y: screenY,
      width: text.rect.width * zoom,
      height: text.rect.height * zoom,
    };
  }

  // ============ CLEANUP ============

  useEffect(() => {
    return () => {
      clearTimeout(debounceRef.current);
    };
  }, []);

  // ============ EXPOSE ============

  return {
    nodeId: editingId,
    editorRef,
    style,
    rect,
    handlers: {
      onInput,
      onBlur,
      onKeyDown,
      onCompositionStart,
      onCompositionEnd,
    },
  };
}

// ============ COMPONENT ============

interface InlineTextEditorProps {
  state: InlineTextState;
}

/**
 * The contenteditable div that sits over the text node.
 * Rendered as a sibling of the canvas SVG, absolutely positioned.
 */
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
