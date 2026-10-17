/**
 * @supa/invoicing/numbering
 * ----------------------------------------------------------------
 * Invoice numbers are per-profile sequences: {prefix}{seq}, e.g.
 *   "INV-0042".
 *
 * Allocation is ATOMIC: INSERT INTO sequence (profile_id, next)
 *   VALUES (..., ...) ON CONFLICT ... RETURNING — the DB hands out
 *   numbers in a single transaction, gaps allowed, collisions
 *   impossible by construction.
 *
 * Drafts do NOT consume numbers (a half-written invoice must not
 *   create a gap the owner sees); numbers allocate at first send.
 *   Abandoned drafts therefore cost nothing.
 *
 * Counter never decreases even on credit notes — credit notes get
 *   their own sequence (CN-...) — a cancelled invoice is voided,
 *   not deleted: auditability means money documents never vanish,
 *   they acquire a status.
 * ----------------------------------------------------------------
 */

import type { WorkspaceId } from "@supa/workspace-core/workspace";

// ───────────────────────────────────────────────
// Sequence kinds — invoice and credit-note are separate
// ───────────────────────────────────────────────

/**
 * The two numbering sequences in this phase. Each has its own
 * counter per profile — they never share state, so a credit note
 * doesn't decrement (or skip) the invoice counter.
 *
 *   invoice     → INV-0001, INV-0002, ...
 *   credit-note → CN-0001, CN-0002, ...
 *
 * Counter never decreases. Adding new kinds here is a deliberate
 * decision (no default-allow).
 */
export type SequenceKind = "invoice" | "credit-note";

// ───────────────────────────────────────────────
// SequenceKey — per-(workspace, profile, kind)
// ───────────────────────────────────────────────

/**
 * The composite key for a numbering sequence. Sequences are scoped
 * per workspace + profile + kind. Two profiles in the same workspace
 * have independent counters (DS-0001 vs CO-0001); two kinds in the
 * same profile have independent counters (INV-0001 vs CN-0001).
 */
export interface SequenceKey {
  readonly wsId: WorkspaceId;
  readonly profileId: string;
  readonly kind: SequenceKind;
}

// ───────────────────────────────────────────────
// NumberAllocator — the atomic allocation contract
// ───────────────────────────────────────────────

/**
 * THE contract: the DB hands out numbers in a single transaction.
 *
 * The reference SQL (Postgres):
 *
 *   INSERT INTO invoice_sequence (ws_id, profile_id, kind, next)
 *   VALUES ($1, $2, $3, 2)
 *   ON CONFLICT (ws_id, profile_id, kind)
 *   DO UPDATE SET next = invoice_sequence.next + 1
 *   RETURNING next - 1 AS allocated;
 *
 * The `RETURNING next - 1` returns the value BEFORE the increment,
 * so the first allocation returns 1, the second returns 2, etc.
 * Gaps are allowed (a transaction that allocates then rolls back
 * leaves a gap — that's correct, gaps are honest); collisions are
 * impossible by construction (the DB serializes the upsert).
 *
 * Drafts do NOT call allocate(). The allocate happens at first
 * SEND (status transition: draft → issued). Abandoned drafts cost
 * nothing — they never touched the counter.
 */
export interface NumberAllocator {
  /**
   * Atomically allocate the next number in the sequence.
   *
   * Returns the allocated integer (1-based). The DB guarantees:
   *   - no two callers get the same number for the same key
   *   - the returned number is monotonically increasing per key
   *   - gaps may occur (if a higher-level transaction rolls back
   *     after allocate() — that's correct, gaps are honest)
   *
   * This MUST be called inside a DB transaction so the allocate
   * + the invoice row insert are atomic. If the invoice insert
   * fails, the allocate is rolled back (gap is created only if
   * the entire transaction commits and a later one rolls back).
   *
   * Throws AllocationError on DB failure.
   */
  allocate(key: SequenceKey): Promise<number>;

  /**
   * Peek at the next number that WOULD be allocated, without
   * consuming it. Used for previews ("your next invoice will be
   * INV-0043"). The peeked value is NOT reserved — a concurrent
   * allocate could consume it before the caller uses it.
   *
   * Never rely on peek() for the actual number — always call
   * allocate() inside the send transaction.
   */
  peek(key: SequenceKey): Promise<number>;
}

export class AllocationError extends Error {
  constructor(
    message: string,
    readonly key: SequenceKey,
  ) {
    super(message);
    this.name = "AllocationError";
  }
}

// ───────────────────────────────────────────────
// Number formatting — {prefix}{seq padded to width}
// ───────────────────────────────────────────────

export interface NumberFormat {
  /** Prefix, e.g. "INV-" or "CN-". */
  readonly prefix: string;
  /** Zero-padding width (default 4 → "0001"). */
  readonly width: number;
}

/**
 * Format an allocated integer as the user-facing invoice number.
 *   format({ prefix: "INV-", width: 4 }, 42) → "INV-0042"
 *   format({ prefix: "CN-", width: 4 }, 1)   → "CN-0001"
 *
 * Width is fixed per profile so numbers align visually. If the
 * sequence overflows the width (e.g. width=4, seq=10000), the
 * number grows naturally ("INV-10000") — no truncation, no
 * collision, just wider than the configured width. This is the
 * honest behavior: the counter is unbounded.
 */
export function formatNumber(format: NumberFormat, seq: number): string {
  if (seq < 1) {
    throw new Error(`sequence must be ≥ 1; got: ${seq}`);
  }
  if (!Number.isInteger(seq)) {
    throw new Error(`sequence must be an integer; got: ${seq}`);
  }
  const str = seq.toString();
  if (str.length >= format.width) {
    return `${format.prefix}${str}`;
  }
  return `${format.prefix}${str.padStart(format.width, "0")}`;
}

/**
 * Default number formats per kind. Profiles can override the prefix
 * (e.g. "DS-" for a design studio profile), but the kind-to-default
 * mapping is fixed here so there's one source of truth.
 */
export const DEFAULT_FORMATS: Record<SequenceKind, NumberFormat> = {
  invoice: { prefix: "INV-", width: 4 },
  "credit-note": { prefix: "CN-", width: 4 },
};

// ───────────────────────────────────────────────
// In-memory allocator (tests + local dev)
// ───────────────────────────────────────────────

/**
 * Reference impl of NumberAllocator. Uses a Map keyed by
 * `${wsId}|${profileId}|${kind}` and BigInt-style atomic increment
 * via Promise chaining.
 *
 * This is NOT a real DB — it doesn't survive process restarts, and
 * the "atomicity" is simulated by single-threaded JS. The contract
 * is the same as the DB impl: collisions impossible, gaps allowed.
 *
 * For production, use the Postgres impl that runs the
 * INSERT ... ON CONFLICT ... RETURNING statement.
 */
export class InMemoryNumberAllocator implements NumberAllocator {
  private readonly counters = new Map<string, number>();
  private readonly locks = new Map<string, Promise<void>>();

  private key(k: SequenceKey): string {
    return `${k.wsId}|${k.profileId}|${k.kind}`;
  }

  async allocate(key: SequenceKey): Promise<number> {
    const k = this.key(key);
    // Serialize concurrent allocations on the same key — simulates
    // DB row-level locking on the sequence row.
    const prevLock = this.locks.get(k) ?? Promise.resolve();
    let release!: () => void;
    const nextLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(k, nextLock);
    await prevLock;
    try {
      const current = this.counters.get(k) ?? 0;
      const allocated = current + 1;
      this.counters.set(k, allocated);
      return allocated;
    } finally {
      release();
      // Only delete the lock if we're still the latest — avoids a
      // race where a newer allocate already replaced the entry.
      if (this.locks.get(k) === nextLock) {
        this.locks.delete(k);
      }
    }
  }

  async peek(key: SequenceKey): Promise<number> {
    const k = this.key(key);
    return (this.counters.get(k) ?? 0) + 1;
  }

  /** Test helper: reset the counter for a key (simulates fresh start). */
  reset(key: SequenceKey): void {
    const k = this.key(key);
    this.counters.delete(k);
    this.locks.delete(k);
  }
}

// ───────────────────────────────────────────────
// Allocation guard — only at status transitions
// ───────────────────────────────────────────────

/**
 * The rule: drafts do NOT consume numbers. Allocation happens only
 * at the draft → issued transition (first send).
 *
 * This guard is the contract enforcer. The invoice repository calls
 * `shouldAllocate(fromStatus, toStatus)` before calling allocate().
 * Returns true ONLY for the draft → issued transition. All other
 * transitions (e.g. issued → paid, issued → voided) do NOT allocate.
 *
 * This is the single place that decides "does this transition
 * consume a number?" — no other code path can allocate.
 */
export function shouldAllocate(
  fromStatus: InvoiceStatus,
  toStatus: InvoiceStatus,
): boolean {
  // Only draft → issued allocates. Everything else is a no-op
  // (the number was allocated at first send, or never was).
  return fromStatus === "draft" && toStatus === "issued";
}

// Local import to avoid cycle — InvoiceStatus is defined in invoice.ts.
// Re-imported here as a type-only import to keep the contract visible.
import type { InvoiceStatus } from "./invoice.js";

// ───────────────────────────────────────────────
// SQL contract — for the Postgres impl
// ───────────────────────────────────────────────

/**
 * The SQL the Postgres NumberAllocator impl runs. Documented here
 * so the DB migration + the allocator impl + the tests all
 * reference the same source of truth.
 *
 * The migration creates:
 *   CREATE TABLE invoice_sequence (
 *     ws_id UUID NOT NULL,
 *     profile_id UUID NOT NULL,
 *     kind TEXT NOT NULL CHECK (kind IN ('invoice', 'credit-note')),
 *     next BIGINT NOT NULL DEFAULT 2,  -- 2 so RETURNING next-1 = 1 on first alloc
 *     PRIMARY KEY (ws_id, profile_id, kind)
 *   );
 *
 * The allocate statement:
 *   INSERT INTO invoice_sequence (ws_id, profile_id, kind, next)
 *   VALUES ($1, $2, $3, 2)
 *   ON CONFLICT (ws_id, profile_id, kind)
 *   DO UPDATE SET next = invoice_sequence.next + 1
 *   RETURNING next - 1 AS allocated;
 *
 * The peek statement:
 *   SELECT COALESCE(MAX(next), 1) FROM invoice_sequence
 *   WHERE ws_id = $1 AND profile_id = $2 AND kind = $3;
 *
 * RLS: rows are scoped by ws_id, so cross-tenant allocation is
 * impossible (the RLS policy refuses the INSERT if the caller's
 * workspace doesn't match).
 */
export const ALLOCATE_SQL = `
INSERT INTO invoice_sequence (ws_id, profile_id, kind, next)
VALUES ($1, $2, $3, 2)
ON CONFLICT (ws_id, profile_id, kind)
DO UPDATE SET next = invoice_sequence.next + 1
RETURNING next - 1 AS allocated;
`;

export const PEEK_SQL = `
SELECT COALESCE(MAX(next), 1) AS next
FROM invoice_sequence
WHERE ws_id = $1 AND profile_id = $2 AND kind = $3;
`;
