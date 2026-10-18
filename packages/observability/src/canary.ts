/**
 * @supa/observability/canary
 * ----------------------------------------------------------------
 * The operability loop, closed.
 *
 * Canary policy: new builds go to 2% of sessions. The canary gate
 * is automated against the dashboards this package feeds:
 *
 *   • crash rate delta
 *   • op latency p99
 *   • drag frame p99
 *   • undo-rate on AI ops
 *
 * Gate fails → automatic rollback. A human reads the why, not the
 * whether. The crash taxonomy's last-20-ops replay means P0
 * reproduction starts from real data, not a user's memory.
 * ----------------------------------------------------------------
 */

// ───────────────────────────────────────────────
// Canary assignment
// ───────────────────────────────────────────────

export type Cohort = "control" | "canary";

/**
 * Sticky 2% canary assignment. Uses a stable hash of accountId so
 * the same account sees the same build across sessions — otherwise
 * we'd measure noise from accounts flipping between builds.
 *
 * Returns "canary" if hash falls in [0, 2%) of the [0, 2^32) range.
 */
export function assignCohort(accountId: string, canaryPercent = 0.02): Cohort {
  const hash = stableHash(accountId);
  // Hash is in [0, 2^32). Threshold at canaryPercent × 2^32.
  const threshold = Math.floor(canaryPercent * 0x100000000);
  return hash < threshold ? "canary" : "control";
}

/**
 * FNV-1a 32-bit hash. Deterministic across JS engines (no BigInt,
 * no observable locale drift). Good enough for cohort assignment.
 */
function stableHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // FNV prime multiplication mod 2^32.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

// ───────────────────────────────────────────────
// Canary metrics
// ───────────────────────────────────────────────

/**
 * Metrics snapshot for a cohort (control or canary) over a window.
 * The canary gate compares these and decides promote / rollback /
 * keep-observing.
 */
export interface CohortMetrics {
  cohort: Cohort;
  /** Sessions observed in window. */
  sessionCount: number;
  /** Crash rate (crashes / sessions), 0..1. */
  crashRate: number;
  /** Op apply latency p99 (ms). */
  opLatencyP99Ms: number;
  /** Drag frame time p99 (ms). Lower = smoother. */
  dragFrameP99Ms: number;
  /** Undo rate within 10s of AI op accept (0..1). */
  aiUndoRate10s: number;
}

// ───────────────────────────────────────────────
// Gate thresholds
// ───────────────────────────────────────────────

export interface CanaryGateThresholds {
  /** Canary crash rate must be within X absolute of control. */
  crashRateDeltaAbs: number;
  /** Canary op latency p99 must be within X% of control. */
  opLatencyP99Rel: number;
  /** Canary drag frame p99 must be within X% of control. */
  dragFrameP99Rel: number;
  /** Canary AI undo-rate must be within X absolute of control. */
  aiUndoRateDeltaAbs: number;
  /** Minimum sessions before evaluating. Statistical noise floor. */
  minSessions: number;
  /** Minimum window (ms) before evaluating. Avoids cold-start skew. */
  minWindowMs: number;
}

const DEFAULT_THRESHOLDS: CanaryGateThresholds = {
  // 0.5pp crash rate delta is the difference between "no change"
  // and "we just shipped a regression".
  crashRateDeltaAbs: 0.005,
  // 20% latency regression is the bar — anything tighter would
  // false-positive on natural variance.
  opLatencyP99Rel: 0.20,
  dragFrameP99Rel: 0.20,
  // 2pp AI undo-rate regression — corresponds to the AI-quality
  // benchmark gate's threshold.
  aiUndoRateDeltaAbs: 0.02,
  minSessions: 200,
  minWindowMs: 15 * 60 * 1000, // 15 min
};

// ───────────────────────────────────────────────
// Gate decision
// ───────────────────────────────────────────────

export type GateDecision =
  | { kind: "promote"; reason: string }
  | { kind: "rollback"; reason: string; failedChecks: FailedCheck[] }
  | { kind: "observe"; reason: string };

export interface FailedCheck {
  metric: "crash-rate" | "op-latency-p99" | "drag-frame-p99" | "ai-undo-rate";
  control: number;
  canary: number;
  delta: number;
  threshold: number;
}

// ───────────────────────────────────────────────
// Canary gate
// ───────────────────────────────────────────────

export interface CanaryGateOptions {
  thresholds?: Partial<CanaryGateThresholds>;
  now?: () => number;
  /** Called when the gate decides to roll back. The host wires this
   *  to the deployment controller (kubectl rollout undo, etc.). */
  onRollback?: (decision: Extract<GateDecision, { kind: "rollback" }>) => void;
  /** Called when the gate decides to promote. */
  onPromote?: (decision: Extract<GateDecision, { kind: "promote" }>) => void;
}

export class CanaryGate {
  private readonly thresholds: CanaryGateThresholds;
  private readonly now: () => number;
  private readonly onRollback: CanaryGateOptions["onRollback"];
  private readonly onPromote: CanaryGateOptions["onPromote"];

  /** Cohort metrics accumulated since the build was promoted to canary. */
  private control: CohortMetrics | null = null;
  private canary: CohortMetrics | null = null;
  private windowStartedAt: number;

  constructor(opts: CanaryGateOptions = {}) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...opts.thresholds };
    this.now = opts.now ?? Date.now;
    this.onRollback = opts.onRollback ?? (() => {});
    this.onPromote = opts.onPromote ?? (() => {});
    this.windowStartedAt = this.now();
  }

  /** Record a cohort metrics snapshot (typically every 5 min). */
  recordMetrics(metrics: CohortMetrics): void {
    if (metrics.cohort === "control") {
      this.control = metrics;
    } else {
      this.canary = metrics;
    }
    // Try to evaluate after each snapshot — the gate is self-driving.
    this.maybeEvaluate();
  }

  private maybeEvaluate(): void {
    const control = this.control;
    const canary = this.canary;
    if (!control || !canary) return;

    const windowMs = this.now() - this.windowStartedAt;
    if (windowMs < this.thresholds.minWindowMs) {
      return; // too early — keep observing
    }
    if (canary.sessionCount < this.thresholds.minSessions) {
      return; // not enough samples
    }

    const decision = this.evaluate(control, canary);
    if (decision.kind === "rollback" && this.onRollback) {
      this.onRollback(decision);
    } else if (decision.kind === "promote" && this.onPromote) {
      this.onPromote(decision);
    }
  }

  /**
   * Pure evaluation — exposed so tests can drive the gate without
   * waiting for the wall clock. Returns the decision; the host
   * decides what to do with it (auto-rollback, auto-promote, or
   * surface to a human for manual review).
   */
  evaluate(control: CohortMetrics, canary: CohortMetrics): GateDecision {
    if (canary.sessionCount < this.thresholds.minSessions) {
      return {
        kind: "observe",
        reason: `canary has ${String(canary.sessionCount)} sessions, need ${String(this.thresholds.minSessions)}`,
      };
    }

    const failed: FailedCheck[] = [];

    // Crash rate — absolute delta.
    const crashDelta = canary.crashRate - control.crashRate;
    if (crashDelta > this.thresholds.crashRateDeltaAbs) {
      failed.push({
        metric: "crash-rate",
        control: control.crashRate,
        canary: canary.crashRate,
        delta: crashDelta,
        threshold: this.thresholds.crashRateDeltaAbs,
      });
    }

    // Op latency p99 — relative delta.
    if (control.opLatencyP99Ms > 0) {
      const opLatRel = (canary.opLatencyP99Ms - control.opLatencyP99Ms) / control.opLatencyP99Ms;
      if (opLatRel > this.thresholds.opLatencyP99Rel) {
        failed.push({
          metric: "op-latency-p99",
          control: control.opLatencyP99Ms,
          canary: canary.opLatencyP99Ms,
          delta: opLatRel,
          threshold: this.thresholds.opLatencyP99Rel,
        });
      }
    }

    // Drag frame p99 — relative delta.
    if (control.dragFrameP99Ms > 0) {
      const dragRel = (canary.dragFrameP99Ms - control.dragFrameP99Ms) / control.dragFrameP99Ms;
      if (dragRel > this.thresholds.dragFrameP99Rel) {
        failed.push({
          metric: "drag-frame-p99",
          control: control.dragFrameP99Ms,
          canary: canary.dragFrameP99Ms,
          delta: dragRel,
          threshold: this.thresholds.dragFrameP99Rel,
        });
      }
    }

    // AI undo-rate — absolute delta.
    const undoDelta = canary.aiUndoRate10s - control.aiUndoRate10s;
    if (undoDelta > this.thresholds.aiUndoRateDeltaAbs) {
      failed.push({
        metric: "ai-undo-rate",
        control: control.aiUndoRate10s,
        canary: canary.aiUndoRate10s,
        delta: undoDelta,
        threshold: this.thresholds.aiUndoRateDeltaAbs,
      });
    }

    if (failed.length > 0) {
      return {
        kind: "rollback",
        reason: `canary failed ${failed.length} check(s): ${failed.map((f) => f.metric).join(", ")}`,
        failedChecks: failed,
      };
    }

    return {
      kind: "promote",
      reason: `canary passed all checks over ${String(canary.sessionCount)} sessions`,
    };
  }

  /** Reset the gate for a new canary build. */
  reset(): void {
    this.control = null;
    this.canary = null;
    this.windowStartedAt = this.now();
  }
}

// ───────────────────────────────────────────────
// P0 reproduction bridge
// ───────────────────────────────────────────────

/**
 * The crash taxonomy's last-20-ops replay means P0 reproduction
 * starts from real data, not a user's memory. This bridge takes a
 * crash report's op trail (types only — no payload, by privacy
 * contract) and produces a deterministic replay schedule that a
 * property-based test harness can run against a fresh doc.
 *
 * The replay doesn't reproduce the EXACT failure — it reproduces
 * the SHAPE of the failing sequence (op-type chain). Combined with
 * the failing invariant, this is enough to write a regression test
 * that catches the bug class.
 */
export interface OpTrailEntry {
  type: string;
  source: "local" | "remote" | "ai";
  latencyMs: number;
}

export interface ReplaySchedule {
  /** Op types in order. */
  opTypes: string[];
  /** Sources in order. */
  sources: ("local" | "remote" | "ai")[];
  /** Total wall-time the original took (ms). */
  totalLatencyMs: number;
  /** Statistical fingerprint for deduping similar reports. */
  fingerprint: string;
}

export function buildReplaySchedule(trail: OpTrailEntry[]): ReplaySchedule {
  const opTypes = trail.map((t) => t.type);
  const sources = trail.map((t) => t.source);
  const totalLatencyMs = trail.reduce((sum, t) => sum + t.latencyMs, 0);
  // Fingerprint = sha-of-op-type-sequence; lets us dedupe reports
  // that hit the same bug from different users.
  const fingerprint = simpleHash(opTypes.join("|"));
  return { opTypes, sources, totalLatencyMs, fingerprint };
}

function simpleHash(s: string): string {
  // FNV-1a 32-bit, hex encoded. Good enough for dedup fingerprinting.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
