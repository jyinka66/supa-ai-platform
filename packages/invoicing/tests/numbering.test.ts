/**
 * Numbering tests — the one truly concurrent problem.
 *
 * Covers:
 *   - collisions impossible (concurrent allocates get distinct numbers)
 *   - gaps allowed (a rolled-back allocate leaves a gap — honest)
 *   - drafts don't consume numbers (only draft → issued allocates)
 *   - counter never decreases
 *   - formatNumber: padding, overflow, prefix
 *   - separate sequences (invoice vs credit-note are independent)
 *   - shouldAllocate: only draft → issued
 *   - peek: doesn't consume
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  InMemoryNumberAllocator,
  formatNumber,
  DEFAULT_FORMATS,
  shouldAllocate,
  type SequenceKey,
  type SequenceKind,
} from "../src/numbering.js";
import type { WorkspaceId } from "@supa/workspace-core/workspace";

// ───────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────

const WS_A = "00000000-0000-0000-0000-000000000001" as WorkspaceId;
const WS_B = "00000000-0000-0000-0000-000000000002" as WorkspaceId;
const PROFILE_1 = "p1";
const PROFILE_2 = "p2";

function key(ws: WorkspaceId, profile: string, kind: SequenceKind): SequenceKey {
  return { wsId: ws, profileId: profile, kind };
}

// ───────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────

describe("InMemoryNumberAllocator — collisions impossible", () => {
  let allocator: InMemoryNumberAllocator;

  beforeEach(() => {
    allocator = new InMemoryNumberAllocator();
  });

  it("sequential allocates return 1, 2, 3, ...", async () => {
    const k = key(WS_A, PROFILE_1, "invoice");
    expect(await allocator.allocate(k)).toBe(1);
    expect(await allocator.allocate(k)).toBe(2);
    expect(await allocator.allocate(k)).toBe(3);
  });

  it("concurrent allocates return distinct numbers (no collisions)", async () => {
    const k = key(WS_A, PROFILE_1, "invoice");
    // Fire 100 concurrent allocates — they must all return distinct numbers.
    const promises = Array.from({ length: 100 }, () => allocator.allocate(k));
    const results = await Promise.all(promises);
    const unique = new Set(results);
    expect(unique.size).toBe(100);
    // The numbers must be 1..100 (some order).
    const sorted = [...unique].sort((a, b) => a - b);
    expect(sorted[0]).toBe(1);
    expect(sorted[99]).toBe(100);
  });

  it("highly concurrent allocates (1000) still no collisions", async () => {
    const k = key(WS_A, PROFILE_1, "invoice");
    const promises = Array.from({ length: 1000 }, () => allocator.allocate(k));
    const results = await Promise.all(promises);
    const unique = new Set(results);
    expect(unique.size).toBe(1000);
  });
});

describe("InMemoryNumberAllocator — gaps allowed", () => {
  let allocator: InMemoryNumberAllocator;

  beforeEach(() => {
    allocator = new InMemoryNumberAllocator();
  });

  it("peek returns the next number without consuming", async () => {
    const k = key(WS_A, PROFILE_1, "invoice");
    expect(await allocator.peek(k)).toBe(1);
    // Peek didn't consume.
    expect(await allocator.peek(k)).toBe(1);
    expect(await allocator.allocate(k)).toBe(1);
    expect(await allocator.peek(k)).toBe(2);
  });

  it("reset simulates a fresh start (gaps from rolled-back allocates)", async () => {
    const k = key(WS_A, PROFILE_1, "invoice");
    expect(await allocator.allocate(k)).toBe(1);
    expect(await allocator.allocate(k)).toBe(2);
    // Reset — simulates the counter state after a rolled-back tx
    // (in real DB, a rolled-back allocate doesn't leave a gap because
    // the tx rolls back; but a higher-level tx that commits the
    // invoice then rolls back a later one DOES leave a gap).
    allocator.reset(k);
    expect(await allocator.allocate(k)).toBe(1);
  });
});

describe("InMemoryNumberAllocator — separate sequences", () => {
  let allocator: InMemoryNumberAllocator;

  beforeEach(() => {
    allocator = new InMemoryNumberAllocator();
  });

  it("invoice and credit-note sequences are independent", async () => {
    const invKey = key(WS_A, PROFILE_1, "invoice");
    const cnKey = key(WS_A, PROFILE_1, "credit-note");
    expect(await allocator.allocate(invKey)).toBe(1);
    expect(await allocator.allocate(invKey)).toBe(2);
    // Credit note counter starts at 1 — invoice allocations didn't touch it.
    expect(await allocator.allocate(cnKey)).toBe(1);
    expect(await allocator.allocate(invKey)).toBe(3);
    expect(await allocator.allocate(cnKey)).toBe(2);
  });

  it("different profiles have independent counters", async () => {
    const k1 = key(WS_A, PROFILE_1, "invoice");
    const k2 = key(WS_A, PROFILE_2, "invoice");
    expect(await allocator.allocate(k1)).toBe(1);
    expect(await allocator.allocate(k2)).toBe(1); // P2 starts at 1
    expect(await allocator.allocate(k1)).toBe(2);
    expect(await allocator.allocate(k2)).toBe(2);
  });

  it("different workspaces have independent counters", async () => {
    const k1 = key(WS_A, PROFILE_1, "invoice");
    const k2 = key(WS_B, PROFILE_1, "invoice");
    expect(await allocator.allocate(k1)).toBe(1);
    expect(await allocator.allocate(k2)).toBe(1); // WS_B starts at 1
    expect(await allocator.allocate(k1)).toBe(2);
  });

  it("counter never decreases", async () => {
    const k = key(WS_A, PROFILE_1, "invoice");
    const n1 = await allocator.allocate(k);
    const n2 = await allocator.allocate(k);
    const n3 = await allocator.allocate(k);
    expect(n2).toBeGreaterThan(n1);
    expect(n3).toBeGreaterThan(n2);
    // Peek (which doesn't consume) should be > n3.
    const peek = await allocator.peek(k);
    expect(peek).toBeGreaterThan(n3);
  });
});

describe("formatNumber", () => {
  it("pads to width 4 by default", () => {
    expect(formatNumber(DEFAULT_FORMATS.invoice, 1)).toBe("INV-0001");
    expect(formatNumber(DEFAULT_FORMATS.invoice, 42)).toBe("INV-0042");
    expect(formatNumber(DEFAULT_FORMATS.invoice, 999)).toBe("INV-0999");
  });

  it("grows naturally when seq overflows width", () => {
    expect(formatNumber(DEFAULT_FORMATS.invoice, 10000)).toBe("INV-10000");
    expect(formatNumber(DEFAULT_FORMATS.invoice, 999999)).toBe("INV-999999");
  });

  it("credit-note format uses CN- prefix", () => {
    expect(formatNumber(DEFAULT_FORMATS["credit-note"], 1)).toBe("CN-0001");
    expect(formatNumber(DEFAULT_FORMATS["credit-note"], 42)).toBe("CN-0042");
  });

  it("custom prefix works", () => {
    const custom = { prefix: "DS-", width: 4 };
    expect(formatNumber(custom, 1)).toBe("DS-0001");
  });

  it("width 0 means no padding", () => {
    const noPad = { prefix: "X-", width: 0 };
    expect(formatNumber(noPad, 42)).toBe("X-42");
  });

  it("rejects seq < 1", () => {
    expect(() => formatNumber(DEFAULT_FORMATS.invoice, 0)).toThrow(/≥ 1/);
    expect(() => formatNumber(DEFAULT_FORMATS.invoice, -1)).toThrow(/≥ 1/);
  });

  it("rejects non-integer seq", () => {
    expect(() => formatNumber(DEFAULT_FORMATS.invoice, 1.5)).toThrow(/integer/);
  });
});

describe("shouldAllocate — drafts don't consume numbers", () => {
  it("only draft → issued allocates", () => {
    expect(shouldAllocate("draft", "issued")).toBe(true);
  });

  it("issued → partial does NOT allocate", () => {
    expect(shouldAllocate("issued", "partial")).toBe(false);
  });

  it("issued → paid does NOT allocate", () => {
    expect(shouldAllocate("issued", "paid")).toBe(false);
  });

  it("issued → voided does NOT allocate (void keeps the number)", () => {
    expect(shouldAllocate("issued", "voided")).toBe(false);
  });

  it("paid → voided does NOT allocate", () => {
    expect(shouldAllocate("paid", "voided")).toBe(false);
  });

  it("draft → voided does NOT allocate (voided draft never had a number)", () => {
    expect(shouldAllocate("draft", "voided")).toBe(false);
  });

  it("voided → anything does NOT allocate (terminal)", () => {
    expect(shouldAllocate("voided", "issued")).toBe(false);
    expect(shouldAllocate("voided", "paid")).toBe(false);
  });
});

describe("numbering contract — the rule stated once", () => {
  it("drafts do NOT consume numbers (allocate only at first send)", () => {
    // The contract: shouldAllocate returns true ONLY for draft → issued.
    // Every other transition is a no-op for the counter.
    const transitions: Array<[any, any]> = [
      ["draft", "issued"],
      ["draft", "voided"],
      ["issued", "partial"],
      ["issued", "paid"],
      ["issued", "voided"],
      ["partial", "paid"],
      ["partial", "voided"],
      ["paid", "voided"],
      ["voided", "issued"],
    ];
    const allocating = transitions.filter(([from, to]) => shouldAllocate(from, to));
    expect(allocating).toEqual([["draft", "issued"]]);
  });

  it("counter never decreases — credit notes get their own sequence", async () => {
    // The credit-note sequence is independent. Allocating a CN-0001
    // does NOT decrement the invoice counter; it's a separate counter.
    const allocator = new InMemoryNumberAllocator();
    const invKey = key(WS_A, PROFILE_1, "invoice");
    const cnKey = key(WS_A, PROFILE_1, "credit-note");

    // Issue 3 invoices (sequential so order is deterministic).
    expect(await allocator.allocate(invKey)).toBe(1);
    expect(await allocator.allocate(invKey)).toBe(2);
    expect(await allocator.allocate(invKey)).toBe(3);

    // Void one — creates a credit note in CN- sequence.
    expect(await allocator.allocate(cnKey)).toBe(1);

    // Invoice counter is STILL at 3 — credit note didn't decrement it.
    expect(await allocator.peek(invKey)).toBe(4);

    // Next invoice is 4, not 2 (counter never decreases).
    expect(await allocator.allocate(invKey)).toBe(4);
  });
});
