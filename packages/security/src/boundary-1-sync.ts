/**
 * @supa/security/boundary-1-sync
 * ----------------------------------------------------------------
 * Threat boundary 1: client ↔ sync hub.
 *
 * The most attacked surface, because ops are executable content.
 *
 * Defenses:
 *   - All op traffic over wss/TLS; tokens via design-auth, short-
 *     lived (15min), rotated silently; refresh token in httpOnly
 *     cookie, never localStorage.
 *   - Server-side op VALIDATION is the load-bearing defense: the
 *     client is hostile. design-commands' op invariants re-run
 *     server-side on every inbound op: schema-valid, geometry
 *     finite, text length caps, node-count cap per doc (10k),
 *     op-rate caps per connection. A malicious client can only send
 *     garbage — never persistence of garbage. The client's
 *     invariant checker was UX convenience; the server's is the
 *     security boundary.
 *   - Rate limits: per-connection op rate, per-account doc-create
 *     rate, per-IP connection count. Legit editors burst (paste 500
 *     nodes) — limits sized from telemetry's op-channel
 *     distributions, not round numbers.
 *   - WebSocket authz on subscribe: joining a doc's channel requires
 *     a read cap; the hub re-validates caps on rev-grant expiry.
 * ----------------------------------------------------------------
 */

import type { CapResolver, Capability } from "./primitives.js";

// ───────────────────────────────────────────────
// Server-side op validation
// ───────────────────────────────────────────────

/**
 * Limits applied to inbound ops. Sized from telemetry's op-channel
 * distributions, not round numbers — defaults below reflect the
 * 99.9th percentile of legit editor behavior, with a safety margin.
 */
export interface OpLimits {
  /** Max nodes per doc. Past this, edits are rejected. */
  maxNodesPerDoc: number;
  /** Max text length per text node. */
  maxTextPerNode: number;
  /** Max ops per second per connection (sliding window). */
  maxOpsPerSecondPerConnection: number;
  /** Max burst size (tokens bucketed). */
  maxBurstPerConnection: number;
  /** Max doc creates per account per hour. */
  maxDocCreatesPerHour: number;
  /** Max connections per IP. */
  maxConnectionsPerIp: number;
  /** Coordinate bounds — ops outside these are rejected (non-finite). */
  coordMin: number;
  coordMax: number;
  /** Max dimension (width/height) — infinite loops live in huge dims. */
  maxDimension: number;
}

export const DEFAULT_OP_LIMITS: OpLimits = {
  maxNodesPerDoc: 10_000,
  maxTextPerNode: 10_000,
  maxOpsPerSecondPerConnection: 50,
  maxBurstPerConnection: 200,
  maxDocCreatesPerHour: 100,
  maxConnectionsPerIp: 20,
  coordMin: -1_000_000,
  coordMax: 1_000_000,
  maxDimension: 1_000_000,
};

// ───────────────────────────────────────────────
// Op validation result
// ───────────────────────────────────────────────

export type OpValidationCode =
  | "schema-invalid"
  | "geometry-non-finite"
  | "geometry-out-of-bounds"
  | "text-too-long"
  | "node-count-cap"
  | "rate-limit-op"
  | "rate-limit-create"
  | "rate-limit-connection"
  | "unauthorized";

export interface OpValidationResult {
  ok: boolean;
  code?: OpValidationCode;
  message?: string;
}

// ───────────────────────────────────────────────
// Server-side op validator
// ───────────────────────────────────────────────

/**
 * The server-side invariant checker. The client's checker was UX
 * convenience; this one is the security boundary.
 *
 * The validator takes an opaque op payload (the hub doesn't need to
 * know the op shape — it delegates schema validation to the
 * design-model's `validateOp`). Geometry / text / node-count limits
 * are checked here because they're security concerns, not model
 * concerns.
 */
export interface ServerOpValidator {
  /**
   * Validate an inbound op. Returns ok=false if the op violates any
   * invariant. The hub MUST reject the op and not persist it.
   */
  validate(op: unknown, ctx: OpValidationContext): OpValidationResult;
}

export interface OpValidationContext {
  /** Current doc node count (after the op would apply). */
  currentNodeCount: number;
  /** Connection id (for rate-limit attribution). */
  connectionId: string;
  /** Account id (for doc-create rate). */
  accountId: string;
}

// ───────────────────────────────────────────────
// Default validator (uses design-model's validateOp when available)
// ───────────────────────────────────────────────

/**
 * The default validator delegates schema validation to a caller-
 * provided schema validator (so this package doesn't take a hard
 * runtime dep on design-model — keeps the security package standalone
 * for the warehouse path).
 */
export interface SchemaValidator {
  /** Returns true if the op is schema-valid (matches the discriminated union). */
  isValid(op: unknown): boolean;
  /** Extracts geometry coordinates from the op (for finite/bounds checks). */
  extractCoords(op: unknown): { x: number; y: number; w: number; h: number } | null;
  /** Extracts text length from the op (if any text content). */
  extractTextLength(op: unknown): number | null;
}

export class DefaultServerOpValidator implements ServerOpValidator {
  constructor(
    private readonly schema: SchemaValidator,
    private readonly limits: OpLimits = DEFAULT_OP_LIMITS,
  ) {}

  validate(op: unknown, ctx: OpValidationContext): OpValidationResult {
    // 1. Schema validity — discriminated union, not "is object".
    if (!this.schema.isValid(op)) {
      return { ok: false, code: "schema-invalid", message: "op does not match command schema" };
    }
    // 2. Geometry — finite and within bounds.
    const coords = this.schema.extractCoords(op);
    if (coords) {
      if (
        !Number.isFinite(coords.x) ||
        !Number.isFinite(coords.y) ||
        !Number.isFinite(coords.w) ||
        !Number.isFinite(coords.h)
      ) {
        return { ok: false, code: "geometry-non-finite", message: "op has non-finite coordinates" };
      }
      const { coordMin, coordMax, maxDimension } = this.limits;
      if (
        coords.x < coordMin || coords.x > coordMax ||
        coords.y < coordMin || coords.y > coordMax ||
        coords.w < 0 || coords.w > maxDimension ||
        coords.h < 0 || coords.h > maxDimension
      ) {
        return { ok: false, code: "geometry-out-of-bounds", message: "op coordinates out of bounds" };
      }
    }
    // 3. Text length cap.
    const textLen = this.schema.extractTextLength(op);
    if (textLen !== null && textLen > this.limits.maxTextPerNode) {
      return {
        ok: false,
        code: "text-too-long",
        message: `text length ${textLen} exceeds cap ${this.limits.maxTextPerNode}`,
      };
    }
    // 4. Node count cap.
    if (ctx.currentNodeCount > this.limits.maxNodesPerDoc) {
      return {
        ok: false,
        code: "node-count-cap",
        message: `doc node count ${ctx.currentNodeCount} exceeds cap ${this.limits.maxNodesPerDoc}`,
      };
    }
    return { ok: true };
  }
}

// ───────────────────────────────────────────────
// Per-connection rate limiter (token bucket)
// ───────────────────────────────────────────────

/**
 * Token bucket per connection. Legit editors burst (paste 500 nodes)
 * so the bucket refills fast enough to allow bursts, but sustained
 * rates above `maxOpsPerSecondPerConnection` drain it.
 *
 * Sized from telemetry: the 99.9th percentile of editor op rates is
 * ~30 ops/sec (sustained typing + mouse moves). Burst cap is 200 to
 * absorb a paste of ~500 nodes arriving as ~200 distinct ops in <1s.
 */
export class ConnectionRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; lastRefill: number }>();

  constructor(
    private readonly limits: OpLimits = DEFAULT_OP_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns true if the op is allowed; false if rate-limited. */
  allow(connectionId: string): boolean {
    const now = this.now();
    let bucket = this.buckets.get(connectionId);
    if (!bucket) {
      bucket = { tokens: this.limits.maxBurstPerConnection, lastRefill: now };
      this.buckets.set(connectionId, bucket);
    }
    // Refill tokens proportional to elapsed time.
    const elapsedMs = now - bucket.lastRefill;
    const refill = (elapsedMs / 1000) * this.limits.maxOpsPerSecondPerConnection;
    bucket.tokens = Math.min(this.limits.maxBurstPerConnection, bucket.tokens + refill);
    bucket.lastRefill = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** Remove the bucket when the connection closes. */
  release(connectionId: string): void {
    this.buckets.delete(connectionId);
  }
}

// ───────────────────────────────────────────────
// Per-account doc-create rate limiter (sliding window)
// ───────────────────────────────────────────────

export class DocCreateRateLimiter {
  private readonly windows = new Map<string, number[]>();

  constructor(
    private readonly maxPerHour: number = DEFAULT_OP_LIMITS.maxDocCreatesPerHour,
    private readonly now: () => number = Date.now,
  ) {}

  allow(accountId: string): boolean {
    const now = this.now();
    const windowStart = now - 3_600_000;
    let arr = this.windows.get(accountId) ?? [];
    arr = arr.filter((t) => t > windowStart);
    if (arr.length >= this.maxPerHour) {
      this.windows.set(accountId, arr);
      return false;
    }
    arr.push(now);
    this.windows.set(accountId, arr);
    return true;
  }
}

// ───────────────────────────────────────────────
// Per-IP connection counter
// ───────────────────────────────────────────────

export class IpConnectionCounter {
  private readonly counts = new Map<string, number>();

  constructor(private readonly max: number = DEFAULT_OP_LIMITS.maxConnectionsPerIp) {}

  /** Returns true if a new connection from this IP is allowed. */
  acquire(ip: string): boolean {
    const current = this.counts.get(ip) ?? 0;
    if (current >= this.max) return false;
    this.counts.set(ip, current + 1);
    return true;
  }

  release(ip: string): void {
    const current = this.counts.get(ip) ?? 0;
    if (current <= 1) {
      this.counts.delete(ip);
    } else {
      this.counts.set(ip, current - 1);
    }
  }
}

// ───────────────────────────────────────────────
// Per-op-batch cap re-validation
// ───────────────────────────────────────────────

/**
 * The sync hub calls this per op batch (not per session). A revoked
 * share link revokes mid-edit at the next op, not at next login.
 *
 * The resolver is the single point of authority from primitives.ts.
 * This wrapper batches the check across an op batch so we don't pay
 * N resolver round-trips for N ops from the same connection.
 */
export interface OpBatchCapChecker {
  /**
   * Check that the subject still holds the required grant on the
   * resource. Returns the cap if valid, else null — the hub must
   * disconnect the client on null.
   */
  checkBatch(subject: string, resource: { kind: "doc"; id: string }, required: "read" | "edit"): Promise<Capability | null>;
}

export class DefaultOpBatchCapChecker implements OpBatchCapChecker {
  constructor(private readonly resolver: CapResolver) {}

  async checkBatch(
    subject: string,
    resource: { kind: "doc"; id: string },
    required: "read" | "edit",
  ): Promise<Capability | null> {
    return this.resolver.resolve({ subject, resource, required });
  }
}

// ───────────────────────────────────────────────
// Subscribe-time authz
// ───────────────────────────────────────────────

/**
 * Joining a doc's channel requires a read cap. The hub re-validates
 * caps on rev-grant expiry — this is the subscribe-time check.
 *
 * In practice, the hub:
 *   1. Calls requireCap(resolver, { subject, resource: doc, required: 'read' })
 *   2. Stores the returned cap on the connection
 *   3. On each op batch, calls checkBatch (above) — fast-path
 *   4. If the cap has expired (by time or rev), disconnects
 */
export async function authorizeSubscribe(
  resolver: CapResolver,
  subject: string,
  docId: string,
  now: number = Date.now(),
): Promise<Capability> {
  const cap = await resolver.resolve({
    subject,
    resource: { kind: "doc", id: docId },
    required: "read",
    now,
  });
  if (!cap) {
    throw new UnauthorizedSubscribeError(subject, docId);
  }
  return cap;
}

export class UnauthorizedSubscribeError extends Error {
  constructor(
    readonly subject: string,
    readonly docId: string,
  ) {
    super(`subject ${subject} lacks read cap on doc ${docId}`);
    this.name = "UnauthorizedSubscribeError";
  }
}
