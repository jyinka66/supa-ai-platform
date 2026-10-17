/**
 * Kanban drag tests.
 *
 * Covers:
 *   - DragStateMachine (idle → maybe-drag → dragging → dropped)
 *   - 8px threshold (below = tap, above = drag)
 *   - long-press promotion (touch)
 *   - drop target detection
 *   - auto-scroll velocity
 *   - canDragOffline (always false — money-adjacent state)
 *   - RafBatcher (batches into single rAF)
 *   - buildDropCommit (one op → one activity → one round-trip)
 */

import { describe, it, expect } from "vitest";
import {
  DragStateMachine,
  computeScrollVelocity,
  findDropTarget,
  canDragOffline,
  RafBatcher,
  buildDropCommit,
  DEFAULT_SCROLL_ZONES,
} from "../src/kanban.js";

const NOW = 1_700_000_000_000;

describe("DragStateMachine", () => {
  it("starts in idle state", () => {
    const sm = new DragStateMachine();
    expect(sm.getState().kind).toBe("idle");
  });

  it("pointerDown enters maybe-drag", () => {
    const sm = new DragStateMachine();
    sm.pointerDown("deal-1", 100, 200, 1, 1000);
    expect(sm.getState().kind).toBe("maybe-drag");
    if (sm.getState().kind === "maybe-drag") {
      expect(sm.getState().dealId).toBe("deal-1");
      expect(sm.getState().startX).toBe(100);
      expect(sm.getState().startY).toBe(200);
    }
  });

  it("pointerMove below threshold stays in maybe-drag", () => {
    const sm = new DragStateMachine();
    sm.pointerDown("deal-1", 100, 200, 1);
    sm.pointerMove(103, 203); // 3px — below 8px threshold
    expect(sm.getState().kind).toBe("maybe-drag");
  });

  it("pointerMove above threshold enters dragging", () => {
    const sm = new DragStateMachine();
    sm.pointerDown("deal-1", 100, 200, 1);
    sm.pointerMove(110, 210); // 10px — above 8px threshold
    expect(sm.getState().kind).toBe("dragging");
  });

  it("pointerUp without drag returns to idle (it was a tap)", () => {
    const sm = new DragStateMachine();
    sm.pointerDown("deal-1", 100, 200, 1);
    sm.pointerUp(null); // no drag → tap
    expect(sm.getState().kind).toBe("idle");
  });

  it("pointerUp during drag with drop target enters dropped", () => {
    const sm = new DragStateMachine();
    sm.pointerDown("deal-1", 100, 200, 1);
    sm.pointerMove(110, 210); // enter dragging
    sm.pointerUp("qualified"); // drop on qualified
    expect(sm.getState().kind).toBe("dropped");
    if (sm.getState().kind === "dropped") {
      expect(sm.getState().dealId).toBe("deal-1");
      expect(sm.getState().toStageId).toBe("qualified");
    }
  });

  it("pointerUp during drag without drop target returns to idle", () => {
    const sm = new DragStateMachine();
    sm.pointerDown("deal-1", 100, 200, 1);
    sm.pointerMove(110, 210);
    sm.pointerUp(null); // dropped outside any column
    expect(sm.getState().kind).toBe("idle");
  });

  it("reset returns to idle after drop", () => {
    const sm = new DragStateMachine();
    sm.pointerDown("deal-1", 100, 200, 1);
    sm.pointerMove(110, 210);
    sm.pointerUp("qualified");
    sm.reset();
    expect(sm.getState().kind).toBe("idle");
  });

  it("cancel returns to idle from any state", () => {
    const sm = new DragStateMachine();
    sm.pointerDown("deal-1", 100, 200, 1);
    sm.pointerMove(110, 210);
    sm.cancel();
    expect(sm.getState().kind).toBe("idle");
  });

  it("pointerDown ignored when not idle", () => {
    const sm = new DragStateMachine();
    sm.pointerDown("deal-1", 100, 200, 1);
    sm.pointerDown("deal-2", 200, 300, 2); // ignored — already in maybe-drag
    expect(sm.getState().kind).toBe("maybe-drag");
    if (sm.getState().kind === "maybe-drag") {
      expect(sm.getState().dealId).toBe("deal-1"); // first deal, not second
    }
  });
});

describe("long-press promotion (touch)", () => {
  it("checkLongPress returns false before threshold", () => {
    const sm = new DragStateMachine();
    sm.pointerDown("deal-1", 100, 200, 1, 1000);
    expect(sm.checkLongPress(1100)).toBe(false); // 100ms < 200ms
    expect(sm.getState().kind).toBe("maybe-drag");
  });

  it("checkLongPress promotes to dragging after threshold", () => {
    const sm = new DragStateMachine();
    sm.pointerDown("deal-1", 100, 200, 1, 1000);
    expect(sm.checkLongPress(1300)).toBe(true); // 300ms > 200ms
    expect(sm.getState().kind).toBe("dragging");
  });

  it("checkLongPress does nothing when not in maybe-drag", () => {
    const sm = new DragStateMachine();
    expect(sm.checkLongPress(1000)).toBe(false);
  });
});

describe("findDropTarget — 8px min", () => {
  const columns = [
    { stageId: "new", rect: { left: 0, top: 0, width: 200, height: 800 } },
    { stageId: "qualified", rect: { left: 220, top: 0, width: 200, height: 800 } },
    { stageId: "won", rect: { left: 440, top: 0, width: 200, height: 800 } },
  ];

  it("finds the column at a pointer position", () => {
    expect(findDropTarget(100, 400, columns)).toBe("new");
    expect(findDropTarget(300, 400, columns)).toBe("qualified");
    expect(findDropTarget(500, 400, columns)).toBe("won");
  });

  it("returns null when pointer is outside all columns", () => {
    expect(findDropTarget(700, 400, columns)).toBeNull();
    expect(findDropTarget(-10, 400, columns)).toBeNull();
  });

  it("returns null when pointer is in the gap between columns", () => {
    expect(findDropTarget(210, 400, columns)).toBeNull(); // gap between new and qualified
  });
});

describe("computeScrollVelocity — auto-scroll zones", () => {
  const containerRect = { left: 0, top: 0, width: 1000, height: 800 };

  it("returns 0 when pointer is in the center", () => {
    const v = computeScrollVelocity(500, 400, containerRect);
    expect(v.dx).toBe(0);
    expect(v.dy).toBe(0);
  });

  it("scrolls up when pointer is near the top edge", () => {
    const v = computeScrollVelocity(500, 10, containerRect);
    expect(v.dy).toBeLessThan(0); // negative = scroll up
    expect(Math.abs(v.dy)).toBeGreaterThan(0);
  });

  it("scrolls down when pointer is near the bottom edge", () => {
    const v = computeScrollVelocity(500, 790, containerRect);
    expect(v.dy).toBeGreaterThan(0); // positive = scroll down
  });

  it("scales linearly from 0 (at zone edge) to maxSpeed (at container edge)", () => {
    // At the very top edge (y=0), velocity should be max.
    const vAtEdge = computeScrollVelocity(500, 0, containerRect);
    // At the zone edge (y=80), velocity should be 0.
    const vAtZoneEdge = computeScrollVelocity(500, 80, containerRect);
    expect(Math.abs(vAtEdge.dy)).toBeGreaterThan(Math.abs(vAtZoneEdge.dy));
    expect(vAtZoneEdge.dy).toBe(0);
  });
});

describe("canDragOffline — money-adjacent state doesn't fork", () => {
  it("always returns false (stage changes require connection)", () => {
    expect(canDragOffline()).toBe(false);
  });
});

describe("RafBatcher — 60fps batching", () => {
  it("batches multiple schedule calls into one rAF", () => {
    let rafCount = 0;
    let appliedValue: number | null = null;
    let pendingCb: (() => void) | null = null;
    const deferredRaf = (cb: () => void) => {
      rafCount++;
      pendingCb = cb; // defer — don't invoke yet
      return 0;
    };
    const batcher = new RafBatcher<number>((v) => { appliedValue = v; }, deferredRaf);
    batcher.schedule(1);
    batcher.schedule(2);
    batcher.schedule(3);
    // Only one rAF scheduled for all three calls (the batcher coalesces).
    expect(rafCount).toBe(1);
    // Now fire the rAF — only the last value (3) is applied.
    pendingCb!();
    expect(appliedValue).toBe(3);
  });

  it("flush applies the pending value immediately", () => {
    let appliedValue: number | null = null;
    const neverRaf = () => 0; // never invokes the callback
    const batcher = new RafBatcher<number>((v) => { appliedValue = v; }, neverRaf);
    batcher.schedule(42);
    expect(appliedValue).toBeNull(); // not yet (rAF didn't fire)
    batcher.flush();
    expect(appliedValue).toBe(42);
  });

  it("cancel drops the pending value", () => {
    let appliedValue: number | null = null;
    const neverRaf = () => 0;
    const batcher = new RafBatcher<number>((v) => { appliedValue = v; }, neverRaf);
    batcher.schedule(42);
    batcher.cancel();
    batcher.flush();
    expect(appliedValue).toBeNull(); // cancelled — nothing applied
  });
});

describe("buildDropCommit — one op → one activity → one round-trip", () => {
  it("builds the drop commit", () => {
    const commit = buildDropCommit("deal-1", "new", "qualified", "user-1", NOW);
    expect(commit.dealId).toBe("deal-1");
    expect(commit.fromStageId).toBe("new");
    expect(commit.toStageId).toBe("qualified");
    expect(commit.actor).toBe("user-1");
    expect(commit.committedAt).toBe(NOW);
  });
});

describe("DEFAULT_SCROLL_ZONES", () => {
  it("has 4 zones (top/bottom/left/right)", () => {
    expect(DEFAULT_SCROLL_ZONES).toHaveLength(4);
    const edges = DEFAULT_SCROLL_ZONES.map((z) => z.edge);
    expect(edges).toContain("top");
    expect(edges).toContain("bottom");
    expect(edges).toContain("left");
    expect(edges).toContain("right");
  });

  it("zones have width 80 + maxSpeed 2", () => {
    for (const z of DEFAULT_SCROLL_ZONES) {
      expect(z.width).toBe(80);
      expect(z.maxSpeed).toBe(2);
    }
  });
});
