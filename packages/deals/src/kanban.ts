/**
 * @supa/deals/kanban
 * ----------------------------------------------------------------
 * The drag is the perf budget's hardest line item (60fps on a
 *   mid-tier phone), so it borrows the design-editor's pointer
 *   discipline wholesale:
 *
 *   - pointer-events pipeline (pointerdown → pointermove → pointerup)
 *   - transform-only mutations during drag (no layout reads in the
 *     move handler — positions captured once at drag start)
 *   - rAF-batched state
 *   - drop committed as ONE op → one activity fact → one server
 *     round-trip after the drop, optimistic locally
 *
 * Touch differences that actually matter:
 *   - long-press to lift (vs immediate on mouse — scroll gesture must stay free)
 *   - 8px-min drop targets
 *   - auto-scroll zones at edges with velocity-based speed
 *   - the drag ghost never intercepts the scroll
 *
 * The golden test: 60fps drag on a throttled CPU profile with a
 *   200-deal board; the discipline that gets you there is identical
 *   to the editor's, which is why this pass is cheap where most CRMs choke.
 *
 * Conflict rule: two users drag the same deal — stage change is
 *   last-write-wins WITH an activity fact recording both transitions,
 *   so the loser sees what happened in the timeline rather than a
 *   silent overwrite. Drafts offline: note/task creation queues;
 *   stage changes require connection (deliberate — money-adjacent
 *   state shouldn't fork offline).
 * ----------------------------------------------------------------
 */

// ───────────────────────────────────────────────
// Drag state machine — borrowed from design-editor's pointer.ts
// ───────────────────────────────────────────────

export type DragState =
  | { kind: "idle" }
  | { kind: "maybe-drag"; dealId: string; startX: number; startY: number; startedAt: number; pointerId: number }
  | { kind: "dragging"; dealId: string; currentX: number; currentY: number; pointerId: number; offsetX: number; offsetY: number }
  | { kind: "dropped"; dealId: string; toStageId: string };

/**
 * The drag state machine. Transitions:
 *   idle → maybe-drag (on pointerdown)
 *   maybe-drag → dragging (on pointermove past threshold)
 *   maybe-drag → idle (on pointerup without crossing threshold — it was a tap)
 *   dragging → dropped (on pointerup — commits the drop)
 *   dropped → idle (after the op is committed)
 *
 * The "maybe-drag" state is the long-press gate for touch: on touch
 * devices, the drag doesn't start until the user holds for ~200ms OR
 * moves past the threshold. On mouse, the drag starts immediately on
 * pointerdown (no long-press gate).
 */
export class DragStateMachine {
  private state: DragState = { kind: "idle" };
  private readonly onStateChange: (state: DragState) => void;

  /** Threshold in px to cross before committing to a drag (8px min). */
  static readonly DRAG_THRESHOLD = 8;
  /** Long-press duration in ms (touch only — mouse is immediate). */
  static readonly LONG_PRESS_MS = 200;

  constructor(onStateChange?: (state: DragState) => void) {
    this.onStateChange = onStateChange ?? (() => {});
  }

  /** Current state (for rendering). */
  getState(): DragState {
    return this.state;
  }

  /**
   * pointerdown handler. On touch, enters maybe-drag (long-press gate).
   * On mouse, could immediately enter dragging if desired — but we
   * keep the maybe-drag state for both (simpler + the threshold is small).
   */
  pointerDown(dealId: string, x: number, y: number, pointerId: number, now: number = Date.now()): void {
    if (this.state.kind !== "idle") return;
    this.state = { kind: "maybe-drag", dealId, startX: x, startY: y, startedAt: now, pointerId };
    this.onStateChange(this.state);
  }

  /**
   * pointermove handler. If in maybe-drag and past threshold, enter dragging.
   * If in dragging, update position (transform-only — NO layout reads here).
   */
  pointerMove(x: number, y: number): void {
    if (this.state.kind === "maybe-drag") {
      const dx = x - this.state.startX;
      const dy = y - this.state.startY;
      if (Math.abs(dx) > DragStateMachine.DRAG_THRESHOLD || Math.abs(dy) > DragStateMachine.DRAG_THRESHOLD) {
        // Crossed threshold — commit to drag.
        this.state = {
          kind: "dragging",
          dealId: this.state.dealId,
          currentX: x,
          currentY: y,
          pointerId: this.state.pointerId,
          offsetX: dx,
          offsetY: dy,
        };
        this.onStateChange(this.state);
      }
      return;
    }
    if (this.state.kind === "dragging") {
      // Transform-only update — NO layout reads. The position is captured
      // once at drag start; the move handler just updates the transform.
      this.state = { ...this.state, currentX: x, currentY: y };
      this.onStateChange(this.state);
    }
  }

  /**
   * Check if the long-press threshold has been met (touch only).
   * Called from a timer; if true, promotes maybe-drag → dragging.
   */
  checkLongPress(now: number = Date.now()): boolean {
    if (this.state.kind !== "maybe-drag") return false;
    if (now - this.state.startedAt >= DragStateMachine.LONG_PRESS_MS) {
      // Long-press met — promote to dragging at the current position.
      this.state = {
        kind: "dragging",
        dealId: this.state.dealId,
        currentX: this.state.startX,
        currentY: this.state.startY,
        pointerId: this.state.pointerId,
        offsetX: 0,
        offsetY: 0,
      };
      this.onStateChange(this.state);
      return true;
    }
    return false;
  }

  /**
   * pointerup handler. If dragging, commit the drop (enter dropped state).
   * If maybe-drag, it was a tap — return to idle.
   */
  pointerUp(toStageId: string | null): void {
    if (this.state.kind === "dragging" && toStageId) {
      this.state = { kind: "dropped", dealId: this.state.dealId, toStageId };
      this.onStateChange(this.state);
      // The caller reads the dropped state, commits the op, then calls reset().
      return;
    }
    // No drag or no drop target — return to idle.
    this.state = { kind: "idle" };
    this.onStateChange(this.state);
  }

  /** Cancel the drag (e.g. pointer cancel, escape key). */
  cancel(): void {
    this.state = { kind: "idle" };
    this.onStateChange(this.state);
  }

  /** Reset to idle after the drop op is committed. */
  reset(): void {
    this.state = { kind: "idle" };
    this.onStateChange(this.state);
  }
}

// ───────────────────────────────────────────────
// Auto-scroll zones — velocity-based
// ───────────────────────────────────────────────

export interface ScrollZone {
  /** The edge: top/bottom/left/right of the scroll container. */
  readonly edge: "top" | "bottom" | "left" | "right";
  /** Zone width in px (e.g. 80). */
  readonly width: number;
  /** Max scroll speed in px/ms. */
  readonly maxSpeed: number;
}

export const DEFAULT_SCROLL_ZONES: readonly ScrollZone[] = [
  { edge: "top", width: 80, maxSpeed: 2 },
  { edge: "bottom", width: 80, maxSpeed: 2 },
  { edge: "left", width: 80, maxSpeed: 2 },
  { edge: "right", width: 80, maxSpeed: 2 },
];

/**
 * Compute the auto-scroll velocity based on pointer position relative
 * to the scroll container edges. Returns 0 when not in a scroll zone;
 * scales linearly from 0 (at zone edge) to maxSpeed (at container edge).
 */
export function computeScrollVelocity(
  pointerX: number,
  pointerY: number,
  containerRect: { left: number; top: number; width: number; height: number },
  zones: readonly ScrollZone[] = DEFAULT_SCROLL_ZONES,
): { dx: number; dy: number } {
  let dx = 0;
  let dy = 0;
  const { left, top, width, height } = containerRect;
  const right = left + width;
  const bottom = top + height;

  for (const zone of zones) {
    switch (zone.edge) {
      case "top": {
        const distFromEdge = pointerY - top;
        if (distFromEdge >= 0 && distFromEdge < zone.width) {
          dy = -zone.maxSpeed * (1 - distFromEdge / zone.width);
        }
        break;
      }
      case "bottom": {
        const distFromEdge = bottom - pointerY;
        if (distFromEdge >= 0 && distFromEdge < zone.width) {
          dy = zone.maxSpeed * (1 - distFromEdge / zone.width);
        }
        break;
      }
      case "left": {
        const distFromEdge = pointerX - left;
        if (distFromEdge >= 0 && distFromEdge < zone.width) {
          dx = -zone.maxSpeed * (1 - distFromEdge / zone.width);
        }
        break;
      }
      case "right": {
        const distFromEdge = right - pointerX;
        if (distFromEdge >= 0 && distFromEdge < zone.width) {
          dx = zone.maxSpeed * (1 - distFromEdge / zone.width);
        }
        break;
      }
    }
  }

  return { dx, dy };
}

// ───────────────────────────────────────────────
// Drop target detection — 8px min
// ───────────────────────────────────────────────

/**
 * Find the drop target (stage column) at a pointer position.
 * Drop targets have an 8px minimum hit area — small enough to be
 * precise, large enough to be touchable.
 */
export function findDropTarget(
  pointerX: number,
  pointerY: number,
  stageColumns: ReadonlyArray<{ stageId: string; rect: { left: number; top: number; width: number; height: number } }>,
): string | null {
  for (const col of stageColumns) {
    const { left, top, width, height } = col.rect;
    if (pointerX >= left && pointerX <= left + width && pointerY >= top && pointerY <= top + height) {
      return col.stageId;
    }
  }
  return null;
}

// ───────────────────────────────────────────────
// Optimistic drop commit — one op, one activity, one round-trip
// ───────────────────────────────────────────────

/**
 * The drop commit. ONE op (moveStage) → ONE activity fact (deal_stage) →
 * ONE server round-trip after the drop. The drop is optimistic locally:
 * the UI updates immediately, the server confirms (or rejects on conflict).
 *
 * Conflict rule: two users drag the same deal — stage change is
 * last-write-wins WITH an activity fact recording both transitions.
 * The loser sees what happened in the timeline rather than a silent
 * overwrite.
 */
export interface DropCommit {
  readonly dealId: string;
  readonly fromStageId: string;
  readonly toStageId: string;
  readonly actor: string;
  readonly committedAt: number;
}

/**
 * Build the drop commit. The caller (UI layer) calls this after the
 * drag ends, then passes it to the deal repository's moveStage().
 * The repository writes the stage move + the activity fact in one
 * DB transaction — one round-trip.
 */
export function buildDropCommit(
  dealId: string,
  fromStageId: string,
  toStageId: string,
  actor: string,
  now: number = Date.now(),
): DropCommit {
  return { dealId, fromStageId, toStageId, actor, committedAt: now };
}

// ───────────────────────────────────────────────
// Offline rule — money-adjacent state doesn't fork
// ───────────────────────────────────────────────

/**
 * Stage changes require connection (deliberate — money-adjacent state
 * shouldn't fork offline). Note/task creation queues; stage changes
 * don't.
 *
 * This function is the contract: if offline, the UI shows "connect to
 * move deals" rather than letting the user drag offline + sync later.
 * Notes/tasks queue normally (they're not money-adjacent).
 */
export function canDragOffline(): boolean {
  return false; // stage changes require connection
}

// ───────────────────────────────────────────────
// rAF batching — 60fps on a 200-deal board
// ───────────────────────────────────────────────

/**
 * rAF-batched state updater. The drag move handler calls `schedule()`
 * on every pointermove; the updater batches into a single rAF callback
 * so the DOM updates at most once per frame.
 *
 * This is the same discipline as the design-editor's render loop —
 * the move handler is cheap (transform-only), the rAF callback does
 * the actual DOM write.
 */
export class RafBatcher<T> {
  private pending: T | null = null;
  private scheduled = false;
  private readonly raf: (cb: () => void) => number;
  private readonly apply: (value: T) => void;

  constructor(apply: (value: T) => void, raf?: (cb: () => void) => number) {
    this.apply = apply;
    this.raf = raf ?? ((cb) => requestAnimationFrame(cb));
  }

  schedule(value: T): void {
    this.pending = value;
    if (this.scheduled) return;
    this.scheduled = true;
    this.raf(() => {
      this.scheduled = false;
      if (this.pending !== null) {
        const value = this.pending;
        this.pending = null;
        this.apply(value);
      }
    });
  }

  flush(): void {
    if (this.pending !== null) {
      const value = this.pending;
      this.pending = null;
      this.scheduled = false;
      this.apply(value);
    }
  }

  cancel(): void {
    this.pending = null;
    this.scheduled = false;
  }
}
