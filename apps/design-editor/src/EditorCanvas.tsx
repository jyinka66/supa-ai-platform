// ─────────────────────────────────────────────────────────────
// EditorCanvas — the SVG canvas + overlay layer.
//
// Structure:
//   <div className="canvas-viewport" onPointerDown={...} onWheel={...}>
//     <div style={{ transform: `translate(...) scale(${zoom})`, transformOrigin: '0 0' }}>
//       <svg dangerouslySetInnerHTML={{ __html: render(page) }} />  ← cached by rev
//       <OverlayLayer />       ← selection chrome, handles, guides, marquee
//     </div>
//   </div>
//
// The SVG is re-set via innerHTML only when rev changed — RenderCache
// makes this a string swap; the browser repaints, no React reconciliation
// over 800 nodes. Overlay is a SEPARATE svg absolutely positioned on top
// so selection chrome never dirties the cached doc render and pointer
// events land on the overlay (with pointer-events: none except handles).
//
// Panning must NOT touch the SVG string: zoom/scroll live in a CSS
// transform on the wrapper div, updated on a rAF loop. The store emit
// for pan/zoom bypasses the doc subscribers (separate listener list).
// ─────────────────────────────────────────────────────────────

"use client";

import { useRef, useEffect, useCallback, type WheelEvent as ReactWheelEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useSyncExternalStore } from "react";
import type { EditorStore, EditorState } from "./store";
import type { PointerController } from "./pointer";
import { screenToPage, pageToScreen, type Point } from "./pointer";
import { renderPage, type RenderCache, CanvasMeasurer, hitTest } from "@supa/design-render";
import type { Page, LayerNode } from "@supa/design-model";
import { findLayerById, findPage } from "@supa/design-model";

// ============ ZOOM STORE (separate emit path) ============

/**
 * Zoom/scroll subscriber list — separate from the doc subscribers.
 * Panning/zooming emits to this list only, so doc components don't re-render
 * when the user pans the canvas.
 *
 * This is the "pass 1's separate emit path" from the spec.
 */
class ZoomStore {
  private zoom = 1;
  private scroll = { x: 0, y: 0 };
  private listeners = new Set<() => void>();

  setZoom = (zoom: number) => {
    this.zoom = zoom;
    this.emit();
  };

  setScroll = (scroll: { x: number; y: number }) => {
    this.scroll = scroll;
    this.emit();
  };

  get = () => ({ zoom: this.zoom, scroll: this.scroll });

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  private emit() {
    for (const fn of this.listeners) fn();
  }
}

// ============ HOOKS ============

/**
 * Subscribes to doc state (selection, tool, transaction).
 * Re-renders when doc content or selection changes.
 */
function useDocState(store: EditorStore): EditorState {
  return useSyncExternalStore(store.subscribe, store.get);
}

/**
 * Subscribes to zoom/scroll ONLY.
 * Panning/zooming doesn't trigger doc component re-renders.
 */
function useZoomState(zoomStore: ZoomStore): { zoom: number; scroll: { x: number; y: number } } {
  return useSyncExternalStore(zoomStore.subscribe, zoomStore.get);
}

// ============ CANVAS COMPONENT ============

interface EditorCanvasProps {
  store: EditorStore;
  pointer: PointerController;
  renderCache: RenderCache;
  zoomStore: ZoomStore;
}

export function EditorCanvas({ store, pointer, renderCache, zoomStore }: EditorCanvasProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const svgContainerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<SVGSVGElement>(null);
  const rafRef = useRef<number>(0);

  const docState = useDocState(store);
  const { zoom, scroll } = useZoomState(zoomStore);

  const page = findPage(docState.doc, docState.pageId);

  // ============ RENDER SVG (cached by rev) ============

  useEffect(() => {
    if (!page) return;

    // Check the render cache — only re-render if the page is dirty.
    const cachedSvg = renderCache.getPageSvg(page.id);
    if (cachedSvg !== null && svgContainerRef.current) {
      // Cache hit — swap the SVG string (no React reconciliation).
      svgContainerRef.current.innerHTML = cachedSvg;
      return;
    }

    // Cache miss — render the page.
    const measurer = new CanvasMeasurer();
    const { svg } = renderPage(docState.doc, measurer, {
      pageId: page.id,
      includeGuides: true,
      selectionIds: docState.selection,
    });

    // Store in cache for next time.
    renderCache.setPageSvg(page.id, svg);

    // Set via innerHTML (no React reconciliation over 800 nodes).
    if (svgContainerRef.current) {
      svgContainerRef.current.innerHTML = svg;
    }
  }, [docState.rev, docState.doc, docState.pageId, page, docState.selection, renderCache]);

  // ============ PAN/ZOOM TRANSFORM (rAF loop) ============

  useEffect(() => {
    const update = () => {
      if (svgContainerRef.current) {
        // Pan/zoom via CSS transform — doesn't touch the SVG string.
        svgContainerRef.current.style.transform =
          `translate(${-scroll.x * zoom}px, ${-scroll.y * zoom}px) scale(${zoom})`;
        svgContainerRef.current.style.transformOrigin = "0 0";
      }
    };

    // Use rAF to batch transform updates with the browser's paint cycle.
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(update);

    return () => cancelAnimationFrame(rafRef.current);
  }, [zoom, scroll]);

  // ============ POINTER HANDLERS ============

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!viewportRef.current || !page) return;

    e.currentTarget.setPointerCapture(e.pointerId);

    const rect = viewportRef.current.getBoundingClientRect();
    const screen: Point = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };

    // Hit test to determine what was clicked.
    const pagePoint = screenToPage(screen, zoom, scroll);
    const hitNode = hitTest(page, pagePoint, zoom);

    // Check if a handle was hit (via the overlay's data attributes).
    const target = e.target as SVGElement;
    const handleId = target.getAttribute("data-handle");
    const nodeId = target.getAttribute("data-node-id");

    // Dispatch to the pointer controller.
    pointer.onPointerDown({
      screen,
      button: e.button,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      targetNodeId: nodeId ?? hitNode?.id ?? null,
      targetHandle: handleId,
    });
  }, [viewportRef, page, zoom, scroll, pointer]);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!viewportRef.current) return;

    const rect = viewportRef.current.getBoundingClientRect();
    const screen: Point = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };

    // Determine hover target (only when idle).
    const editorState = store.get();
    const hitNodeId = editorState.transaction ? null : (() => {
      if (!page) return null;
      const pagePoint = screenToPage(screen, zoom, scroll);
      const hit = hitTest(page, pagePoint, zoom);
      return hit?.id ?? null;
    })();

    pointer.onPointerMove({
      screen,
      button: e.buttons,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      targetNodeId: hitNodeId,
      targetHandle: null,
    });
  }, [viewportRef, page, zoom, scroll, pointer, store]);

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!viewportRef.current) return;

    e.currentTarget.releasePointerCapture(e.pointerId);

    const rect = viewportRef.current.getBoundingClientRect();
    const screen: Point = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };

    pointer.onPointerUp({
      screen,
      button: e.button,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      targetNodeId: null,
      targetHandle: null,
    });
  }, [viewportRef, pointer]);

  // ============ WHEEL HANDLER ============

  const onWheel = useCallback((e: ReactWheelEvent<HTMLDivElement>) => {
    if (!viewportRef.current) return;

    e.preventDefault();

    const rect = viewportRef.current.getBoundingClientRect();
    const screen: Point = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };

    pointer.onWheel({
      screen,
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
    });
  }, [viewportRef, pointer]);

  // ============ KEYBOARD (Escape to cancel) ============

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        pointer.onEscape();
      }
      pointer.onKeyDown(e);
    };
    const onKeyUp = (e: KeyboardEvent) => pointer.onKeyUp(e);

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [pointer]);

  // ============ CONNECT ZOOM STORE TO EDITOR STORE ============

  // When the editor store's zoom/scroll changes, sync to the zoom store.
  useEffect(() => {
    zoomStore.setZoom(docState.zoom);
    zoomStore.setScroll(docState.scroll);
  }, [docState.zoom, docState.scroll, zoomStore]);

  // ============ RENDER ============

  if (!page) {
    return (
      <div className="flex items-center justify-center h-full text-textMuted">
        <p>No page selected</p>
      </div>
    );
  }

  return (
    <div
      ref={viewportRef}
      className="canvas-viewport relative h-full w-full overflow-hidden bg-neutral-100 dark:bg-neutral-900"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onWheel={onWheel}
      style={{ touchAction: "none" }} // disable browser touch gestures
    >
      {/* Content layer — SVG rendered via innerHTML, cached by rev */}
      <div
        ref={svgContainerRef}
        className="absolute left-0 top-0"
        style={{
          transform: `translate(${-scroll.x * zoom}px, ${-scroll.y * zoom}px) scale(${zoom})`,
          transformOrigin: "0 0",
          willChange: "transform", // hint to the browser for GPU compositing
        }}
      >
        {/* The SVG is injected via innerHTML in the effect above. */}
        {/* This div is a container — the SVG string is set directly. */}
      </div>

      {/* Overlay layer — selection chrome, handles, marquee (separate SVG) */}
      <OverlayLayer
        store={store}
        page={page}
        zoom={zoom}
        scroll={scroll}
        marqueeRect={pointer.marqueeRect}
      />
    </div>
  );
}

// ============ OVERLAY LAYER ============

interface OverlayLayerProps {
  store: EditorStore;
  page: Page;
  zoom: number;
  scroll: { x: number; y: number };
  marqueeRect: { startPage: Point; currentPage: Point } | null;
}

export function OverlayLayer({ store, page, zoom, scroll, marqueeRect }: OverlayLayerProps) {
  const state = useDocState(store);

  // Compute screen-space positions for selected nodes.
  const selectedRects = state.selection
    .map((id) => {
      const node = findLayerById(page, id);
      if (!node) return null;
      const screenPos = pageToScreen({ x: node.rect.x, y: node.rect.y }, zoom, scroll);
      return {
        id,
        x: screenPos.x,
        y: screenPos.y,
        width: node.rect.width * zoom,
        height: node.rect.height * zoom,
        rotation: node.rotation,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  // Hover highlight.
  const hoverNode = state.hoverId ? findLayerById(page, state.hoverId) : null;
  const hoverScreen = hoverNode
    ? pageToScreen({ x: hoverNode.rect.x, y: hoverNode.rect.y }, zoom, scroll)
    : null;

  // Marquee rect in screen space.
  const marqueeScreen = marqueeRect
    ? {
        x: Math.min(marqueeRect.startPage.x, marqueeRect.currentPage.x),
        y: Math.min(marqueeRect.startPage.y, marqueeRect.currentPage.y),
        width: Math.abs(marqueeRect.currentPage.x - marqueeRect.startPage.x),
        height: Math.abs(marqueeRect.currentPage.y - marqueeRect.startPage.y),
      }
    : null;

  return (
    <svg
      className="absolute left-0 top-0 h-full w-full pointer-events-none"
      style={{ overflow: "visible" }}
    >
      {/* Hover highlight */}
      {hoverScreen && hoverNode && (
        <rect
          x={hoverScreen.x}
          y={hoverScreen.y}
          width={hoverNode.rect.width * zoom}
          height={hoverNode.rect.height * zoom}
          fill="none"
          stroke="#3b82f6"
          strokeWidth={1}
          opacity={0.4}
          rx={2}
        />
      )}

      {/* Selection chrome */}
      {selectedRects.map((rect) => (
        <SelectionChrome key={rect.id} rect={rect} zoom={zoom} />
      ))}

      {/* Marquee */}
      {marqueeScreen && (
        <rect
          x={marqueeScreen.x * zoom - scroll.x * zoom}
          y={marqueeScreen.y * zoom - scroll.y * zoom}
          width={marqueeScreen.width * zoom}
          height={marqueeScreen.height * zoom}
          fill="rgba(59, 130, 246, 0.1)"
          stroke="#3b82f6"
          strokeWidth={1}
          strokeDasharray="4 2"
        />
      )}
    </svg>
  );
}

// ============ SELECTION CHROME ============

interface SelectionChromeProps {
  rect: {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number;
  };
  zoom: number;
}

function SelectionChrome({ rect, zoom }: SelectionChromeProps) {
  const handleSize = 8;
  const handleOffset = handleSize / 2;

  // Handle positions (relative to the rect).
  const handles = [
    { id: "nw", x: 0, y: 0 },
    { id: "n", x: rect.width / 2, y: 0 },
    { id: "ne", x: rect.width, y: 0 },
    { id: "w", x: 0, y: rect.height / 2 },
    { id: "e", x: rect.width, y: rect.height / 2 },
    { id: "sw", x: 0, y: rect.height },
    { id: "s", x: rect.width / 2, y: rect.height },
    { id: "se", x: rect.width, y: rect.height },
  ];

  // Rotate handle (above the top edge).
  const rotateHandleY = -24 / zoom;
  const rotateLineY = -12 / zoom;

  return (
    <g transform={`translate(${rect.x}, ${rect.y}) rotate(${rect.rotation} ${rect.width / 2} ${rect.height / 2})`}>
      {/* Selection rect */}
      <rect
        x={0}
        y={0}
        width={rect.width}
        height={rect.height}
        fill="none"
        stroke="#3b82f6"
        strokeWidth={1.5 / zoom}
        rx={1}
      />

      {/* Rotate handle line + circle */}
      <line
        x1={rect.width / 2}
        y1={0}
        x2={rect.width / 2}
        y2={rotateLineY}
        stroke="#3b82f6"
        strokeWidth={1 / zoom}
      />
      <circle
        cx={rect.width / 2}
        cy={rotateHandleY}
        r={handleOffset / zoom}
        fill="#3b82f6"
        data-handle="rotate"
        data-node-id={rect.id}
        style={{ pointerEvents: "all", cursor: "grab" }}
      />

      {/* Resize handles */}
      {handles.map((h) => (
        <rect
          key={h.id}
          x={h.x - handleOffset / zoom}
          y={h.y - handleOffset / zoom}
          width={handleSize / zoom}
          height={handleSize / zoom}
          fill="#fff"
          stroke="#3b82f6"
          strokeWidth={1.5 / zoom}
          data-handle={h.id}
          data-node-id={rect.id}
          style={{
            pointerEvents: "all",
            cursor: getHandleCursor(h.id),
          }}
        />
      ))}
    </g>
  );
}

function getHandleCursor(handle: string): string {
  switch (handle) {
    case "nw": case "se": return "nwse-resize";
    case "ne": case "sw": return "nesw-resize";
    case "n": case "s": return "ns-resize";
    case "e": case "w": return "ew-resize";
    default: return "default";
  }
}
