// ─────────────────────────────────────────────────────────────
// Pointer state machine. All canvas interaction flows through here —
// no component attaches its own onPointerMove. States:
//
//   idle ──down──▶ maybe-click ──(move > 4px screen)──▶ drag-{move|resize|rotate}
//                     │ (up)                            │ (up)
//                     ▼                                 ▼
//                  clicked (select)                  committed
//
//   idle ──down on empty──▶ marquee ──up──▶ select-in-rect
//   idle ──down on handle──▶ drag-resize (handle id in payload)
//   idle ──middle/space+down──▶ pan
//   wheel ─▶ zoom-at-cursor (ctrl/meta) or pan (plain, two-finger trackpad)
//
// Screen→page conversion is the ONLY place zoom/scroll math lives:
//   page = screen / zoom + scroll
//   zoom-at-cursor: keep the page point under the cursor fixed:
//     scroll' = page - screen / zoom'
// ─────────────────────────────────────────────────────────────

import type { EditorStore, EditorState } from "./store";

// ============ TYPES ============

export type Vec2 = { x: number; y: number };
export type Point = Vec2;

export type HandleId =
  | "nw" | "n" | "ne"
  | "w" | "e"
  | "sw" | "s" | "se"
  | "rotate";

export type ResizeHandle = Exclude<HandleId, "rotate">;

/**
 * Pointer payload — the two kinds of pointer-down events the machine accepts.
 *
 * The machine receives raw pointerdown/move/up (with capture) and emits
 * store calls only — no rendering, no math outside transform helpers.
 * This keeps the machine unit-testable: feed synthetic pointer sequences,
 * assert store ops.
 */
export type PointerPayload =
  | { kind: "canvas-down"; page: Vec2; hit: string | null; hitHandle: string | null; button: number; shift: boolean; meta: boolean }
  | { kind: "handle-down"; handle: HandleId; nodeId: string; page: Vec2; shift: boolean };

export type PointerState =
  | { kind: "idle" }
  | { kind: "maybe-click"; downScreen: Point; downPage: Point; button: number; targetNodeId: string | null; targetHandle: string | null }
  | { kind: "drag-move"; startScreen: Point; startPage: Point; nodeIds: string[] }
  | { kind: "drag-resize"; startScreen: Point; startPage: Point; nodeId: string; handle: ResizeHandle }
  | { kind: "drag-rotate"; startScreen: Point; centerPage: Point; nodeId: string; startRotation: number }
  | { kind: "marquee"; startScreen: Point; startPage: Point; currentPage: Point }
  | { kind: "pan"; startScroll: { x: number; y: number }; lastScreen: Point };

export interface PointerEvent {
  screen: Point;
  button: number;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  targetNodeId: string | null;
  targetHandle: string | null;
}

export interface WheelEvent {
  screen: Point;
  deltaX: number;
  deltaY: number;
  ctrlKey: boolean;
  metaKey: boolean;
}

// ============ CONSTANTS ============

const DRAG_THRESHOLD_PX = 4; // screen pixels before maybe-click → drag
const ZOOM_SENSITIVITY = 0.001;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 64;

// ============ POINTER CONTROLLER ============

export class PointerController {
  private state: PointerState = { kind: "idle" };
  private spacePressed = false;

  constructor(private store: EditorStore) {}

  // ============ KEYBOARD (for space-to-pan) ============

  onKeyDown(e: KeyboardEvent): void {
    if (e.code === "Space" && !e.repeat) {
      this.spacePressed = true;
    }
  }

  onKeyUp(e: KeyboardEvent): void {
    if (e.code === "Space") {
      this.spacePressed = false;
    }
  }

  // ============ POINTER DOWN ============

  onPointerDown(e: PointerEvent): void {
    const editorState = this.store.get();
    const pagePoint = screenToPage(e.screen, editorState.zoom, editorState.scroll);

    // Middle button OR space+left → pan.
    if (e.button === 1 || (e.button === 0 && this.spacePressed)) {
      this.state = {
        kind: "pan",
        startScroll: { ...editorState.scroll },
        lastScreen: { ...e.screen },
      };
      return;
    }

    // Left button on a handle → resize.
    if (e.button === 0 && e.targetHandle) {
      const nodeId = e.targetNodeId!;
      this.state = {
        kind: "drag-resize",
        startScreen: { ...e.screen },
        startPage: pagePoint,
        nodeId,
        handle: e.targetHandle as ResizeHandle,
      };
      this.store.beginTransaction("resize", pagePoint);
      return;
    }

    // Left button on a node → maybe-click or drag-move.
    if (e.button === 0 && e.targetNodeId) {
      // If the node isn't already selected, select it.
      if (!editorState.selection.includes(e.targetNodeId)) {
        if (e.shiftKey) {
          // Add to selection.
          this.store.setSelection([...editorState.selection, e.targetNodeId]);
        } else {
          this.store.setSelection([e.targetNodeId]);
        }
      }

      this.state = {
        kind: "maybe-click",
        downScreen: { ...e.screen },
        downPage: pagePoint,
        button: e.button,
        targetNodeId: e.targetNodeId,
        targetHandle: e.targetHandle,
      };
      return;
    }

    // Left button on empty space → marquee select OR deselect.
    if (e.button === 0 && !e.targetNodeId) {
      if (!e.shiftKey) {
        this.store.clearSelection();
      }
      this.state = {
        kind: "marquee",
        startScreen: { ...e.screen },
        startPage: pagePoint,
        currentPage: pagePoint,
      };
      return;
    }

    // Right button → context menu (handled by component, not here).
    // Other buttons → ignore.
  }

  // ============ POINTER MOVE ============

  onPointerMove(e: PointerEvent): void {
    const editorState = this.store.get();
    const pagePoint = screenToPage(e.screen, editorState.zoom, editorState.scroll);

    switch (this.state.kind) {
      case "idle":
        // Just update hover.
        this.store.setHoverId(e.targetNodeId);
        break;

      case "maybe-click": {
        // Check if we've crossed the drag threshold.
        const dx = e.screen.x - this.state.downScreen.x;
        const dy = e.screen.y - this.state.downScreen.y;
        const dist = Math.hypot(dx, dy);

        if (dist > DRAG_THRESHOLD_PX) {
          // Transition to drag-move.
          const nodeIds = editorState.selection.length > 0
            ? editorState.selection
            : [this.state.targetNodeId!];

          this.state = {
            kind: "drag-move",
            startScreen: { ...this.state.downScreen },
            startPage: { ...this.state.downPage },
            nodeIds,
          };

          this.store.beginTransaction("move", this.state.startPage);
        }
        break;
      }

      case "drag-move": {
        // Compute delta from start.
        const dx = pagePoint.x - this.state.startPage.x;
        const dy = pagePoint.y - this.state.startPage.y;

        // Apply UPDATE_PROPS for each selected node (ephemeral — no history).
        for (const nodeId of this.state.nodeIds) {
          // Find the node + its current rect.
          const node = findNodeInDoc(editorState.doc, nodeId);
          if (!node) continue;

          // The start position was captured in the transaction snapshot.
          // We need the ORIGINAL rect from the snapshot, not the current one
          // (which changes on every move). The snapshot is stored in the transaction.
          const snapshot = editorState.transaction?.snapshot;
          if (!snapshot) continue;

          const originalNode = findNodeInDoc(snapshot, nodeId);
          if (!originalNode) continue;

          const newX = originalNode.rect.x + dx;
          const newY = originalNode.rect.y + dy;

          this.store.apply({
            op: "UPDATE_PROPS",
            pageId: editorState.pageId,
            id: nodeId,
            props: { rect: { ...originalNode.rect, x: newX, y: newY } },
          }, { ephemeral: true });
        }
        break;
      }

      case "drag-resize": {
        // Compute new rect based on handle + drag delta.
        const node = findNodeInDoc(editorState.transaction?.snapshot ?? editorState.doc, this.state.nodeId);
        if (!node) break;

        const originalRect = node.rect;
        const dx = pagePoint.x - this.state.startPage.x;
        const dy = pagePoint.y - this.state.startPage.y;

        const newRect = resizeRect(originalRect, this.state.handle, dx, dy, e.shiftKey);

        this.store.apply({
          op: "UPDATE_PROPS",
          pageId: editorState.pageId,
          id: this.state.nodeId,
          props: { rect: newRect },
        }, { ephemeral: true });
        break;
      }

      case "drag-rotate": {
        // Compute angle from center to current pointer.
        const angle = Math.atan2(
          pagePoint.y - this.state.centerPage.y,
          pagePoint.x - this.state.centerPage.x,
        );
        const degrees = (angle * 180) / Math.PI + 90; // 0 = north

        this.store.apply({
          op: "UPDATE_PROPS",
          pageId: editorState.pageId,
          id: this.state.nodeId,
          props: { rotation: e.shiftKey ? Math.round(degrees / 15) * 15 : degrees },
        }, { ephemeral: true });
        break;
      }

      case "marquee": {
        // Update the current page point (for rendering the selection rect).
        this.state = { ...this.state, currentPage: pagePoint };
        // Emit so the canvas repaints the marquee overlay.
        this.store.setHoverId(null);
        break;
      }

      case "pan": {
        // Pan: scroll follows pointer delta.
        const dx = e.screen.x - this.state.lastScreen.x;
        const dy = e.screen.y - this.state.lastScreen.y;
        const zoom = editorState.zoom;

        this.store.setScroll({
          x: this.state.startScroll.x - dx / zoom,
          y: this.state.startScroll.y - dy / zoom,
        });

        this.state = { ...this.state, lastScreen: { ...e.screen } };
        break;
      }
    }
  }

  // ============ POINTER UP ============

  onPointerUp(e: PointerEvent): void {
    switch (this.state.kind) {
      case "maybe-click": {
        // It was a click, not a drag → select (already done in pointer down).
        this.state = { kind: "idle" };
        break;
      }

      case "drag-move":
      case "drag-resize":
      case "drag-rotate": {
        // Commit the transaction (single undo step).
        this.store.endTransaction();
        this.state = { kind: "idle" };
        break;
      }

      case "marquee": {
        // Select all nodes within the marquee rect.
        const editorState = this.store.get();
        const pagePoint = screenToPage(e.screen, editorState.zoom, editorState.scroll);
        const rect = {
          x: Math.min(this.state.startPage.x, pagePoint.x),
          y: Math.min(this.state.startPage.y, pagePoint.y),
          width: Math.abs(pagePoint.x - this.state.startPage.x),
          height: Math.abs(pagePoint.y - this.state.startPage.y),
        };

        // Find nodes intersecting the rect.
        const page = editorState.doc.pages.find((p) => p.id === editorState.pageId);
        if (page) {
          const hits: string[] = [];
          for (const layer of page.layers) {
            if (layer.hidden || layer.locked) continue;
            if (rectsIntersect(layer.rect, rect)) {
              hits.push(layer.id);
            }
          }
          this.store.setSelection(hits);
        }

        this.state = { kind: "idle" };
        break;
      }

      case "pan": {
        this.state = { kind: "idle" };
        break;
      }

      case "idle":
        // Nothing to do.
        break;
    }
  }

  // ============ WHEEL ============

  onWheel(e: WheelEvent): void {
    const editorState = this.store.get();

    if (e.ctrlKey || e.metaKey) {
      // Zoom at cursor: keep the page point under the cursor fixed.
      const pagePoint = screenToPage(e.screen, editorState.zoom, editorState.scroll);
      const factor = Math.exp(-e.deltaY * ZOOM_SENSITIVITY);
      const newZoom = clamp(editorState.zoom * factor, MIN_ZOOM, MAX_ZOOM);

      // scroll' = page - screen / zoom'
      this.store.setZoom(newZoom);
      this.store.setScroll({
        x: pagePoint.x - e.screen.x / newZoom,
        y: pagePoint.y - e.screen.y / newZoom,
      });
    } else {
      // Pan.
      this.store.setScroll({
        x: editorState.scroll.x + e.deltaX / editorState.zoom,
        y: editorState.scroll.y + e.deltaY / editorState.zoom,
      });
    }
  }

  // ============ ESCAPE ============

  onEscape(): void {
    if (this.state.kind === "drag-move" || this.state.kind === "drag-resize" || this.state.kind === "drag-rotate") {
      this.store.cancelTransaction();
    }
    this.state = { kind: "idle" };
  }

  // ============ ACCESS ============

  get currentState(): PointerState {
    return this.state;
  }

  get isPanning(): boolean {
    return this.state.kind === "pan";
  }

  get isDragging(): boolean {
    return this.state.kind === "drag-move" || this.state.kind === "drag-resize" || this.state.kind === "drag-rotate";
  }

  get marqueeRect(): { startPage: Point; currentPage: Point } | null {
    if (this.state.kind !== "marquee") return null;
    return { startPage: this.state.startPage, currentPage: this.state.currentPage };
  }
}

// ============ COORDINATE MATH ============

/**
 * Converts screen coordinates to page coordinates.
 *
 *   page = screen / zoom + scroll
 *
 * This is the ONLY place this math lives — all other code calls this.
 */
export function screenToPage(
  screen: Point,
  zoom: number,
  scroll: { x: number; y: number },
): Point {
  return {
    x: screen.x / zoom + scroll.x,
    y: screen.y / zoom + scroll.y,
  };
}

/**
 * Converts page coordinates to screen coordinates.
 */
export function pageToScreen(
  page: Point,
  zoom: number,
  scroll: { x: number; y: number },
): Point {
  return {
    x: (page.x - scroll.x) * zoom,
    y: (page.y - scroll.y) * zoom,
  };
}

// ============ RESIZE MATH ============

/**
 * Computes a new rect based on a resize handle + drag delta.
 *
 * @param original   The original rect (from the transaction snapshot).
 * @param handle     Which handle is being dragged.
 * @param dx         Page-space delta X.
 * @param dy         Page-space delta Y.
 * @param aspectLock If true, maintain the original aspect ratio (Shift key).
 */
function resizeRect(
  original: { x: number; y: number; width: number; height: number },
  handle: ResizeHandle,
  dx: number,
  dy: number,
  aspectLock: boolean,
): { x: number; y: number; width: number; height: number } {
  let { x, y, width, height } = original;

  // Adjust based on handle.
  switch (handle) {
    case "nw": x += dx; y += dy; width -= dx; height -= dy; break;
    case "n": y += dy; height -= dy; break;
    case "ne": y += dy; width += dx; height -= dy; break;
    case "w": x += dx; width -= dx; break;
    case "e": width += dx; break;
    case "sw": x += dx; width -= dx; height += dy; break;
    case "s": height += dy; break;
    case "se": width += dx; height += dy; break;
  }

  // Aspect ratio lock (Shift key).
  if (aspectLock && original.width > 0 && original.height > 0) {
    const ratio = original.width / original.height;
    if (Math.abs(dx) > Math.abs(dy)) {
      height = width / ratio;
      if (handle.includes("n")) y = original.y + original.height - height;
    } else {
      width = height * ratio;
      if (handle.includes("w")) x = original.x + original.width - width;
    }
  }

  // Prevent negative dimensions (flip handle if crossing zero).
  if (width < 0) { x += width; width = -width; }
  if (height < 0) { y += height; height = -height; }

  return { x, y, width, height };
}

// ============ HELPERS ============

function findNodeInDoc(doc: import("@supa/design-model").DesignDoc, nodeId: string) {
  for (const page of doc.pages) {
    const node = findLayerById(page, nodeId);
    if (node) return node;
  }
  return null;
}

function findLayerById(page: import("@supa/design-model").Page, id: string): import("@supa/design-model").LayerNode | null {
  function search(node: import("@supa/design-model").LayerNode): import("@supa/design-model").LayerNode | null {
    if (node.id === id) return node;
    if (node.children) {
      for (const child of node.children) {
        const found = search(child);
        if (found) return found;
      }
    }
    return null;
  }
  for (const layer of page.layers) {
    const found = search(layer);
    if (found) return found;
  }
  return null;
}

function rectsIntersect(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
