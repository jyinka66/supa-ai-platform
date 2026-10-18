/**
 * @supa/observability/crash
 * ----------------------------------------------------------------
 * Crash taxonomy. Errors are classified at capture, not triaged
 * later — the taxonomy IS the SLO contract.
 *
 *   E_RENDERER   render worker threw → recoverable (RenderCache
 *                invalidates, resyncs from doc). Auto-recover +
 *                report. Recovering crashes must NOT lose the
 *                transaction: endTransaction() is called in the
 *                recovery path.
 *
 *   E_SYNC       transport error → offline state machine handles;
 *                only report if retry budget exhausted.
 *
 *   E_AI         provider error/timeout → degrade to manual flow,
 *                report with provider+model tags.
 *
 *   E_EDITOR     logic errors (pointer state machine invariant
 *                violation, store op apply failure) — the only P0
 *                class. Store invariant check runs in dev AND on
 *                every op in canary builds.
 *
 * Error boundaries per region (canvas / inspector / panels) so an
 * inspector bug doesn't take down the canvas. Crash report includes
 * the last 20 ops (types only) — replayable skeletons for repro.
 * ----------------------------------------------------------------
 */

import type { TelemetryClient } from "./telemetry.js";

// ───────────────────────────────────────────────
// Taxonomy
// ───────────────────────────────────────────────

export type CrashClass = "E_RENDERER" | "E_SYNC" | "E_AI" | "E_EDITOR";

export type CrashSeverity = "P0" | "P1" | "P2";

interface CrashClassDef {
  severity: CrashSeverity;
  recoverable: boolean;
  /**
   * Recovery action label sent in the report. The actual recovery
   * logic lives in the editor; this string is the contract so the
   * warehouse can correlate recovery success to class.
   */
  recovery: string;
}

const TAXONOMY: Record<CrashClass, CrashClassDef> = {
  E_RENDERER: {
    severity: "P2",
    recoverable: true,
    recovery: "RenderCache.invalidate()+resync",
  },
  E_SYNC: {
    severity: "P2",
    recoverable: true,
    recovery: "SyncLifecycle.toOffline()",
  },
  E_AI: {
    severity: "P1",
    recoverable: true,
    recovery: "degrade-to-manual",
  },
  E_EDITOR: {
    severity: "P0",
    recoverable: false,
    recovery: "none — page reload required",
  },
};

// ───────────────────────────────────────────────
// Op replay skeleton (last 20 ops)
// ───────────────────────────────────────────────

export interface OpSkeleton {
  /** Command discriminator ("InsertLayer", "SetStyle", etc.). */
  type: string;
  /** Source: local user, remote peer, or AI. */
  source: "local" | "remote" | "ai";
  /** Latency at apply time; useful for slow-op correlation. */
  latencyMs: number;
}

/**
 * Bounded ring of the last N ops. The crash report carries ONLY this
 * skeleton — never the op payload. The skeleton is enough to
 * reconstruct the *shape* of the failing sequence and feed a
 * property-based test that replays the same op-type chain against a
 * fresh doc.
 */
export class OpRing {
  private static readonly CAPACITY = 20;
  private readonly buf: OpSkeleton[] = [];
  private head = 0;

  push(skel: OpSkeleton): void {
    if (this.buf.length < OpRing.CAPACITY) {
      this.buf.push(skel);
    } else {
      this.buf[this.head] = skel;
      this.head = (this.head + 1) % OpRing.CAPACITY;
    }
  }

  /** Returns ops in chronological order (oldest first). */
  snapshot(): OpSkeleton[] {
    if (this.buf.length < OpRing.CAPACITY) return [...this.buf];
    return [...this.buf.slice(this.head), ...this.buf.slice(0, this.head)];
  }

  clear(): void {
    this.buf.length = 0;
    this.head = 0;
  }
}

// ───────────────────────────────────────────────
// Crash report payload
// ───────────────────────────────────────────────

export interface CrashReport {
  /** Stable id so we can dedupe the same crash across retries. */
  reportId: string;
  /** Class from taxonomy. */
  klass: CrashClass;
  /** Severity, derived from taxonomy. */
  severity: CrashSeverity;
  /** Recovery action label (from taxonomy). */
  recovery: string;
  /** Whether the recovery succeeded (set after the recovery path runs). */
  recovered: boolean;
  /** Error message + stack — server-side redaction is the backstop,
   *  but we strip here too so client-side console logs are clean. */
  message: string;
  stack: string | undefined;
  /** Last 20 op types — replayable skeleton. */
  opTrail: OpSkeleton[];
  /** Editor region where the boundary caught the error. */
  region: EditorRegion;
  /** Optional tags (provider, model) for E_AI. */
  tags: Record<string, string> | undefined;
  /** Build hash. */
  bundleVersion: string;
  /** Client clock at capture. */
  ts: number;
}

export type EditorRegion = "canvas" | "inspector" | "layers" | "bind" | "palette" | "app";

// ───────────────────────────────────────────────
// Region error boundary helpers (React-agnostic)
// ───────────────────────────────────────────────

export interface RegionBoundary {
  region: EditorRegion;
  /** Called when a child throws; should call captureCrash and trigger recovery. */
  onError(error: unknown): void;
}

// ───────────────────────────────────────────────
// Invariant check (dev + canary)
// ───────────────────────────────────────────────

export interface InvariantViolation {
  kind:
    | "parent-missing"
    | "cycle"
    | "orphan-layer"
    | "non-finite-coords"
    | "negative-dims"
    | "doc-root-missing";
  /** ULID of the offending layer (or "doc-root" for doc-level). */
  layerId: string;
  detail?: string;
}

export interface InvariantChecker {
  /**
   * Throws InvariantViolationError if any invariant is broken.
   * Runs in dev on every op; on canary builds runs in prod. In
   * stable prod it's gated behind a flag to avoid the perf hit.
   */
  assertValid(): void;
  /** Non-throwing variant — returns the list of violations. */
  check(): InvariantViolation[];
}

export class InvariantViolationError extends Error {
  readonly violations: InvariantViolation[];
  constructor(violations: InvariantViolation[]) {
    super(`Invariant violations: ${violations.map((v) => v.kind).join(", ")}`);
    this.name = "InvariantViolationError";
    this.violations = violations;
  }
}

// ───────────────────────────────────────────────
// CrashReporter
// ───────────────────────────────────────────────

export interface CrashReporterOptions {
  telemetry: TelemetryClient;
  /** Build hash from __BUILD_HASH__. */
  bundleVersion: string;
  /** Override clock (tests). */
  now?: () => Date;
  /** Submit endpoint (POST). Defaults to /api/observability/crash. */
  endpoint?: string;
  /** Override fetch (tests). */
  fetch?: typeof fetch;
  /** Stable installation id, used for deduping the same crash on retry. */
  installId: string;
}

export class CrashReporter {
  private readonly telemetry: TelemetryClient;
  private readonly bundleVersion: string;
  private readonly now: () => Date;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly installId: string;
  private readonly opRing = new OpRing();

  /** Tracks whether recovery has run for the in-flight report. */
  private recoveryInFlight: { reportId: string; klass: CrashClass } | null = null;

  constructor(opts: CrashReporterOptions) {
    this.telemetry = opts.telemetry;
    this.bundleVersion = opts.bundleVersion;
    this.now = opts.now ?? (() => new Date());
    this.endpoint = opts.endpoint ?? "/api/observability/crash";
    this.fetchImpl = opts.fetch ?? fetch;
    this.installId = opts.installId;
  }

  // ─────────── op trail ───────────

  /** Called from store subscription on every applied op. */
  recordOp(skel: OpSkeleton): void {
    this.opRing.push(skel);
  }

  // ─────────── capture ───────────

  /**
   * Capture an error in a region. Classifies by taxonomy, builds the
   * op trail, sends the report, and returns the reportId so the
   * caller can pair the recovery result.
   */
  capture(
    error: unknown,
    region: EditorRegion,
    opts?: { classOverride?: CrashClass; tags?: Record<string, string> },
  ): string {
    const klass = opts?.classOverride ?? this.classify(error, region);
    const def = TAXONOMY[klass];
    const reportId = this.generateReportId();
    const { message, stack } = this.normalizeError(error);

    const report: CrashReport = {
      reportId,
      klass,
      severity: def.severity,
      recovery: def.recovery,
      recovered: false,
      message,
      stack,
      opTrail: this.opRing.snapshot(),
      region,
      tags: opts?.tags,
      bundleVersion: this.bundleVersion,
      ts: this.now().getTime(),
    };

    this.recoveryInFlight = { reportId, klass };
    this.telemetry.markCrashRecovery();

    // Fire-and-forget; never block recovery on the network.
    void this.submit(report);

    return reportId;
  }

  /**
   * Called by the recovery path after it has run (successfully or
   * not). Pair this with capture() by reportId.
   */
  markRecovered(reportId: string, recovered: boolean): void {
    if (this.recoveryInFlight?.reportId !== reportId) {
      // Stale — ignore.
      return;
    }
    this.recoveryInFlight = null;
    // Patch report on the server via a follow-up PATCH.
    void this.fetchImpl(this.endpoint, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reportId, recovered, installId: this.installId }),
      keepalive: true,
    }).catch(() => {
      /* swallow */
    });
  }

  // ─────────── invariant check bridge ───────────

  /**
   * Hook for the store to call after each op. In dev/canary, runs
   * the full invariant check. Throws (and reports E_EDITOR) on any
   * violation.
   */
  assertStoreInvariants(checker: InvariantChecker, region: EditorRegion = "canvas"): void {
    const violations = checker.check();
    if (violations.length === 0) return;
    const err = new InvariantViolationError(violations);
    this.capture(err, region, { classOverride: "E_EDITOR" });
    throw err;
  }

  // ─────────── classification ───────────

  private classify(error: unknown, _region: EditorRegion): CrashClass {
    // Default heuristics — callers can override with classOverride
    // when they know better (e.g., sync transport wraps its own errors).
    if (error instanceof InvariantViolationError) return "E_EDITOR";
    if (error instanceof DOMException && error.name === "InvalidStateError") {
      // Common when the render worker's OffscreenCanvas is detached.
      return "E_RENDERER";
    }
    const msg = error instanceof Error ? error.message : String(error);
    if (/transport|websocket|network/i.test(msg)) return "E_SYNC";
    if (/provider|gemini|groq|openrouter|timeout/i.test(msg)) return "E_AI";
    return "E_EDITOR";
  }

  // ─────────── helpers ───────────

  private normalizeError(error: unknown): { message: string; stack: string | undefined } {
    if (error instanceof Error) {
      // Stack can contain user content (file paths, layer ids in
      // console logs) — we send it because P0 debugging needs it,
      // but the server-side redactor is the backstop.
      return { message: error.message.slice(0, 512), stack: error.stack?.slice(0, 4096) };
    }
    return { message: String(error).slice(0, 512), stack: undefined };
  }

  private generateReportId(): string {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return crypto.randomUUID();
    }
    return `${this.installId}-${String(this.now().getTime())}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private async submit(report: CrashReport): Promise<void> {
    try {
      await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ report, installId: this.installId }),
        keepalive: true,
      });
    } catch {
      /* swallow — never let crash reporting itself throw */
    }
  }
}

// ───────────────────────────────────────────────
// Region error boundary (React hook)
// ───────────────────────────────────────────────

/**
 * Tiny adapter so React error boundaries can call into the reporter
 * without depending on React here. The editor passes its own
 * componentDidCatch hook.
 */
export function makeRegionHandler(
  reporter: CrashReporter,
  region: EditorRegion,
): RegionBoundary["onError"] {
  return (error: unknown) => {
    reporter.capture(error, region);
  };
}
