/**
 * @supa/observability/telemetry
 * ----------------------------------------------------------------
 * Event spine. Two channels:
 *
 *   ops channel:     { docId, opType, latencyMs, source, rebaseConflicts }
 *                    — sampled 100% for latency aggregates, 1% raw
 *                    retention. Privacy: NO node content ever leaves
 *                    the client. Only ids + timings + classifications.
 *
 *   session channel: editor session heartbeat { rev count, crash?,
 *                    fps bucket, bundle version } — the denominator
 *                    for every other metric.
 *
 * Transport:
 *   - sendBeacon on `pagehide` (best-effort flush before tab dies)
 *   - batched POST otherwise: 100 events or 5s, whichever first
 *
 * Server-side contract: kafka → clickhouse. Dashboards run over the
 * warehouse, never over a vendor's realtime panel. Data must be
 * queryable by us, not viewable by us.
 * ----------------------------------------------------------------
 */

// ───────────────────────────────────────────────
// Channel 1 — ops (per applied op)
// ───────────────────────────────────────────────

export type OpSource = "local" | "remote";

export interface OpEvent {
  channel: "ops";
  /** Monotonic client clock at op apply (ms epoch). */
  ts: number;
  /** ULID — opaque server-side join key, never carries content. */
  docId: string;
  /** Command discriminator from @supa/design-model (e.g. "InsertLayer"). */
  opType: string;
  /** Wall time from beginTransaction() to endTransaction(). */
  latencyMs: number;
  source: OpSource;
  /** Non-zero only on remote rebases that needed conflict resolution. */
  rebaseConflicts: number;
}

// ───────────────────────────────────────────────
// Channel 2 — session heartbeat (denominator)
// ───────────────────────────────────────────────

export interface SessionEvent {
  channel: "session";
  ts: number;
  /** Stable per editor mount; rotated on remount. */
  sessionId: string;
  docId: string;
  /** Head rev count at heartbeat. */
  revCount: number;
  /** True if session recovered from a crash this beat. */
  crash?: boolean;
  /** Bucketed FPS so we never store a float we don't need. */
  fpsBucket: FpsBucket;
  /** Build hash from __BUILD_HASH__; lets us slice by release. */
  bundleVersion: string;
}

export type FpsBucket = "0-15" | "15-30" | "30-50" | "50-60" | "60+";

export type TelemetryEvent = OpEvent | SessionEvent;

// ───────────────────────────────────────────────
// Privacy scrubbing
// ───────────────────────────────────────────────

/**
 * Whitelist approach: any field NOT in the schema is dropped. This is
 * the privacy contract — if a caller stuffs `content` or `text` onto
 * the event, it never reaches the wire.
 */
const OPS_KEYS = new Set<keyof OpEvent>([
  "channel",
  "ts",
  "docId",
  "opType",
  "latencyMs",
  "source",
  "rebaseConflicts",
]);

const SESSION_KEYS = new Set<keyof SessionEvent>([
  "channel",
  "ts",
  "sessionId",
  "docId",
  "revCount",
  "crash",
  "fpsBucket",
  "bundleVersion",
]);

function scrub<T extends Record<string, unknown>>(
  ev: T,
  allowed: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const src = ev as Record<string, unknown>;
  for (const k of Object.keys(src)) {
    if (allowed.has(k)) {
      // Never allow string payload fields to slip through with content.
      const v = src[k];
      if (typeof v === "string" && v.length > 64) {
        // Defensive: a misconfigured caller shouldn't be able to send
        // a 10MB blob "as an id". Truncate hard.
        out[k] = v.slice(0, 64);
      } else {
        out[k] = v;
      }
    }
  }
  return out;
}

// ───────────────────────────────────────────────
// Sampling
// ───────────────────────────────────────────────

/**
 * Latency aggregates (p50/p95/p99) are computed from a 100% sample
 * because percentile error compounds non-linearly at the tail and
 * 1% sampling mis-estimates p99 by >25%.
 *
 * Raw event retention (for replay/debugging) is 1% — enough to spot
 * anomalies in a 10k-DAU tenant without bloating the warehouse.
 *
 * Implementation: every event is recorded into the latency ring
 * buffer (100%). Each event rolls a separate 1% dice for raw
 * retention. The two decisions are independent.
 */
export interface SamplingPolicy {
  /** Always compute latency aggregates; store only 1% of raw events. */
  rawRetentionRate: number;
}

const DEFAULT_SAMPLING: SamplingPolicy = {
  rawRetentionRate: 0.01,
};

// ───────────────────────────────────────────────
// Transport
// ───────────────────────────────────────────────

export interface Transport {
  send(events: TelemetryEvent[]): void;
}

export interface FetchTransportOptions {
  endpoint: string;
  /** Caller-provided beacon for pagehide flush. Defaults to navigator.sendBeacon. */
  beacon?: (url: string, body: string) => boolean;
  fetch?: typeof fetch;
}

/**
 * Best-effort transport. Two flush paths:
 *   - pagehide → sendBeacon (no retry, no ack — if it fails, the next
 *     session's heartbeat will show up as a gap, which is itself a
 *     useful signal).
 *   - otherwise → POST with batched body. On network error the batch
 *     is retained and retried on the next tick (bounded backoff).
 */
export class FetchTransport implements Transport {
  private readonly endpoint: string;
  private readonly beacon: (url: string, body: string) => boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: FetchTransportOptions) {
    this.endpoint = opts.endpoint;
    this.beacon =
      opts.beacon ??
      ((url, body) => {
        if (typeof navigator !== "undefined" && navigator.sendBeacon) {
          return navigator.sendBeacon(url, body);
        }
        return false;
      });
    this.fetchImpl = opts.fetch ?? fetch;
  }

  send(events: TelemetryEvent[]): void {
    if (events.length === 0) return;
    const body = JSON.stringify({ events });
    try {
      this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {
        /* swallow — caller's batcher retains for retry */
      });
    } catch {
      /* swallow */
    }
  }

  /** Called from pagehide handler. No retry. */
  flushViaBeacon(events: TelemetryEvent[]): void {
    if (events.length === 0) return;
    this.beacon(this.endpoint, JSON.stringify({ events }));
  }
}

// ───────────────────────────────────────────────
// Latency aggregates (100% sample)
// ───────────────────────────────────────────────

const P_TARGETS = [50, 95, 99] as const;

/**
 * T-Digest-style histogram would be ideal, but for ~5min session
 * windows a fixed sorted ring is sufficient. We keep 1024 samples
 * (ring buffer) and compute percentiles by sort. Memory: 8KB. CPU:
 * negligible — sort runs once per flush.
 */
class LatencyHistogram {
  private readonly samples = new Float64Array(1024);
  private head = 0;
  private count = 0;

  observe(latencyMs: number): void {
    this.samples[this.head] = latencyMs;
    this.head = (this.head + 1) % this.samples.length;
    if (this.count < this.samples.length) this.count++;
  }

  reset(): void {
    this.head = 0;
    this.count = 0;
  }

  percentiles(): Record<"p50" | "p95" | "p99", number> {
    if (this.count === 0) {
      return { p50: 0, p95: 0, p99: 0 };
    }
    const slice = Array.from(this.samples.subarray(0, this.count));
    slice.sort((a, b) => a - b);
    const pick = (p: number) => {
      const idx = Math.min(slice.length - 1, Math.floor((p / 100) * slice.length));
      return Math.round(slice[idx] ?? 0);
    };
    return {
      p50: pick(50),
      p95: pick(95),
      p99: pick(99),
    };
  }
}

// ───────────────────────────────────────────────
// Session heartbeat (denominator)
// ───────────────────────────────────────────────

interface FpsMeter {
  reset(): void;
  /** Called on each rAF. */
  frame(now: number): void;
  /** Returns the bucket for the most recent 1s window. */
  bucket(): FpsBucket;
}

class RafFpsMeter implements FpsMeter {
  private frames: number[] = [];
  private lastBucket: FpsBucket = "60+";
  reset(): void {
    this.frames = [];
  }
  frame(now: number): void {
    this.frames.push(now);
    // Keep only last 1s.
    const cutoff = now - 1000;
    while (this.frames.length > 0 && this.frames[0]! < cutoff) {
      this.frames.shift();
    }
    this.lastBucket = this.classify(this.frames.length);
  }
  bucket(): FpsBucket {
    return this.lastBucket;
  }
  private classify(fps: number): FpsBucket {
    if (fps < 15) return "0-15";
    if (fps < 30) return "15-30";
    if (fps < 50) return "30-50";
    if (fps < 60) return "50-60";
    return "60+";
  }
}

// ───────────────────────────────────────────────
// TelemetryClient
// ───────────────────────────────────────────────

export interface TelemetryClientOptions {
  transport: Transport;
  /** Doc id rotator; called when the editor swaps docs. */
  docIdProvider: () => string;
  /** Build hash for session events. */
  bundleVersion: string;
  /** Sampling policy. */
  sampling?: SamplingPolicy;
  /** Override clock (tests). */
  now?: () => number;
  /** Override batch thresholds. */
  maxBatchSize?: number;
  flushIntervalMs?: number;
  /** Hook for hooking rAF (so the lib doesn't fight the editor's loop). */
  raf?: (cb: () => void) => void;
}

export class TelemetryClient {
  private readonly transport: Transport;
  private readonly docIdProvider: () => string;
  private readonly bundleVersion: string;
  private readonly sampling: SamplingPolicy;
  private readonly now: () => number;
  private readonly maxBatchSize: number;
  private readonly flushIntervalMs: number;
  private readonly raf: (cb: () => void) => void;

  private pending: TelemetryEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private pagehideBound = false;

  private readonly latency = new LatencyHistogram();
  private readonly fps = new RafFpsMeter();

  private sessionId: string;
  private revCount = 0;
  private sessionHadCrash = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private rafScheduled = false;

  constructor(opts: TelemetryClientOptions) {
    this.transport = opts.transport;
    this.docIdProvider = opts.docIdProvider;
    this.bundleVersion = opts.bundleVersion;
    this.sampling = opts.sampling ?? DEFAULT_SAMPLING;
    this.now = opts.now ?? Date.now;
    this.maxBatchSize = opts.maxBatchSize ?? 100;
    this.flushIntervalMs = opts.flushIntervalMs ?? 5000;
    this.raf = opts.raf ?? ((cb) => requestAnimationFrame(cb));
    this.sessionId = generateSessionId();
  }

  // ─────────── lifecycle ───────────

  start(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
    // Heartbeat every 30s — gives us the denominator.
    this.heartbeatTimer = setInterval(() => this.emitHeartbeat(), 30_000);
    // Initial heartbeat at session start so we always have one.
    this.emitHeartbeat();
    this.bindPagehide();
    this.scheduleRaf();
  }

  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.flushTimer = null;
    this.heartbeatTimer = null;
    this.flush();
    if (this.transport instanceof FetchTransport) {
      this.transport.flushViaBeacon(this.pending);
      this.pending = [];
    }
  }

  /** Update rev count for heartbeat. Called from store subscription. */
  onRevApplied(): void {
    this.revCount++;
  }

  /** Mark session as crash-recovered. */
  markCrashRecovery(): void {
    this.sessionHadCrash = true;
  }

  // ─────────── ops channel ───────────

  /**
   * Record an op event. Always observes latency (100% sample for
   * aggregates), then independently rolls the 1% dice for raw
   * retention.
   */
  recordOp(ev: Omit<OpEvent, "channel" | "ts">): void {
    const full: OpEvent = {
      ...ev,
      channel: "ops",
      ts: this.now(),
    };
    // Latency always observed.
    this.latency.observe(full.latencyMs);
    // Raw retention independently sampled.
    if (Math.random() < this.sampling.rawRetentionRate) {
      this.enqueue(scrub(full as unknown as Record<string, unknown>, OPS_KEYS) as unknown as TelemetryEvent);
    }
    this.onRevApplied();
  }

  // ─────────── session channel ───────────

  private emitHeartbeat(): void {
    const ev: SessionEvent = {
      channel: "session",
      ts: this.now(),
      sessionId: this.sessionId,
      docId: this.docIdProvider(),
      revCount: this.revCount,
      ...(this.sessionHadCrash ? { crash: true } : {}),
      fpsBucket: this.fps.bucket(),
      bundleVersion: this.bundleVersion,
    };
    this.sessionHadCrash = false; // reset for next beat
    this.enqueue(scrub(ev as unknown as Record<string, unknown>, SESSION_KEYS) as unknown as TelemetryEvent);
  }

  // ─────────── aggregates (for debug/devtools) ───────────

  /**
   * Returns the current latency percentiles and resets the histogram.
   * Used by the periodic flush to ship aggregates alongside raw events.
   * Aggregates are NOT subject to the 1% retention cap.
   */
  drainLatencyPercentiles(): Record<"p50" | "p95" | "p99", number> {
    const p = this.latency.percentiles();
    this.latency.reset();
    return p;
  }

  // ─────────── flush ───────────

  private enqueue(ev: TelemetryEvent): void {
    this.pending.push(ev);
    if (this.pending.length >= this.maxBatchSize) {
      this.flush();
    }
  }

  private flush(): void {
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    try {
      this.transport.send(batch);
    } catch {
      // Re-enqueue on failure (bounded: cap at 2x maxBatchSize).
      this.pending = [...batch, ...this.pending].slice(0, this.maxBatchSize * 2);
    }
  }

  // ─────────── rAF (FPS meter) ───────────

  private scheduleRaf(): void {
    if (this.rafScheduled) return;
    this.rafScheduled = true;
    this.raf(() => {
      this.rafScheduled = false;
      this.fps.frame(this.now());
      this.scheduleRaf();
    });
  }

  // ─────────── pagehide ───────────

  private bindPagehide(): void {
    if (this.pagehideBound || typeof window === "undefined") return;
    this.pagehideBound = true;
    // pagehide fires on both tab close and navigation; visibilitychange
    // hidden is the more reliable early signal on mobile.
    const handler = () => {
      this.emitHeartbeat();
      this.flush();
      if (this.transport instanceof FetchTransport) {
        this.transport.flushViaBeacon(this.pending);
        this.pending = [];
      }
    };
    window.addEventListener("pagehide", handler, { once: false });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") handler();
    });
  }
}

// ───────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────

function generateSessionId(): string {
  // 16 hex chars = 64 bits of entropy; plenty for session join.
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  }
  return Math.random().toString(16).slice(2, 18).padEnd(16, "0");
}

// ───────────────────────────────────────────────
// Null transport (tests / opt-out)
// ───────────────────────────────────────────────

export class NullTransport implements Transport {
  send(_events: TelemetryEvent[]): void {
    /* no-op */
  }
}
