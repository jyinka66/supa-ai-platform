/**
 * @supa/test-fixtures/crash-replay
 * ----------------------------------------------------------------
 * Crash-replay skeleton bridge, consolidated from @supa/observability's
 * canary module. Takes the crash taxonomy's last-20-ops trail (types
 * only — no payload by privacy contract) and produces a deterministic
 * replay schedule that a property-based test harness can run against
 * a fresh doc.
 *
 * The replay doesn't reproduce the EXACT failure — it reproduces the
 * SHAPE of the failing sequence (op-type chain). Combined with the
 * failing invariant, this is enough to write a regression test that
 * catches the bug class.
 *
 * The golden test: a P0 crash in production → the op trail arrives
 * via telemetry → buildCrashReplaySchedule() produces a replay →
 * the CI property test runs the replay against the current codebase →
 * if it reproduces, the bug is catchable in CI; if it doesn't, the
 * fix is confirmed.
 * ----------------------------------------------------------------
 */

// ───────────────────────────────────────────────
// Crash replay skeleton
// ───────────────────────────────────────────────

export interface OpTrailEntry {
  /** Command discriminator ("InsertLayer", "SetStyle", etc.). */
  type: string;
  /** Source: local user, remote peer, or AI. */
  source: "local" | "remote" | "ai";
  /** Latency at apply time (ms). */
  latencyMs: number;
}

export interface CrashReplaySkeleton {
  /** Op types in order. */
  opTypes: readonly string[];
  /** Sources in order ("local" | "remote" | "ai"). */
  sources: readonly string[];
  /** Total wall-time the original took (ms). */
  totalLatencyMs: number;
  /** Statistical fingerprint for deduping similar reports. */
  fingerprint: string;
  /** Crash class (from the crash taxonomy). */
  crashClass: string;
  /** Region where the crash was caught. */
  region: string;
}

// ───────────────────────────────────────────────
// Curated crash-replay skeletons — known bug shapes
// ───────────────────────────────────────────────

export const CRASH_REPLAY_SKELETONS: readonly CrashReplaySkeleton[] = Object.freeze([
  {
    opTypes: Object.freeze(["InsertLayer", "SetStyle", "DeleteLayer"]),
    sources: Object.freeze(["local", "local", "local"]),
    totalLatencyMs: 45,
    fingerprint: "a1b2c3d4",
    crashClass: "E_EDITOR",
    region: "canvas",
    // Bug: deleting a layer that was just styled triggered a stale
    // reference in the render cache. Fixed by invalidating the cache
    // on DeleteLayer.
  },
  {
    opTypes: Object.freeze(["InsertLayer", "InsertLayer", "InsertLayer"]),
    sources: Object.freeze(["local", "remote", "ai"]),
    totalLatencyMs: 120,
    fingerprint: "e5f607a8",
    crashClass: "E_RENDERER",
    region: "canvas",
    // Bug: concurrent inserts from local + remote + AI raced on the
    // render cache. Fixed by serializing via the op log's seq.
  },
  {
    opTypes: Object.freeze(["InsertLayer"]),
    sources: Object.freeze(["ai"]),
    totalLatencyMs: 5000,
    fingerprint: "190a1b2c",
    crashClass: "E_AI",
    region: "inspector",
    // Bug: AI-generated op with a 5s latency (provider timeout).
    // Fixed by the fallback chain — degrade to manual flow after
    // softTimeoutMs.
  },
  {
    opTypes: Object.freeze(["InsertLayer", "SetStyle", "SetStyle", "SetStyle"]),
    sources: Object.freeze(["local", "local", "local", "local"]),
    totalLatencyMs: 8,
    fingerprint: "3a405a6b",
    crashClass: "E_EDITOR",
    region: "inspector",
    // Bug: rapid style changes (drag-scrub on a color input)
    // triggered a pointer state machine invariant violation.
    // Fixed by batching style changes via rAF.
  },
  {
    opTypes: Object.freeze(["InsertLayer", "DeleteLayer"]),
    sources: Object.freeze(["local", "remote"]),
    totalLatencyMs: 15,
    fingerprint: "71829a0b",
    crashClass: "E_SYNC",
    region: "canvas",
    // Bug: local delete raced with remote insert — the remote op
    // referenced a deleted layer. Fixed by the sync hub's op log
    // rebase logic.
  },
]);

// ───────────────────────────────────────────────
// buildCrashReplaySchedule — the canary gate's bridge
// ───────────────────────────────────────────────

/**
 * Build a replay schedule from a crash report's op trail. This is
 * the bridge between the crash taxonomy (@supa/observability/crash)
 * and the canary gate (@supa/observability/canary).
 *
 * The crash report carries the last 20 ops (types only — no payload
 * by privacy contract). This function produces a deterministic
 * op-type chain + sources + total latency + fingerprint.
 *
 * The fingerprint (FNV-1a of the op-type sequence) lets us dedupe
 * reports of the same bug from different users — 50 users hitting
 * the same crash produce the same fingerprint, so the replay test
 * runs once, not 50 times.
 */
export function buildCrashReplaySchedule(
  trail: readonly OpTrailEntry[],
  crashClass: string = "E_EDITOR",
  region: string = "canvas",
): CrashReplaySkeleton {
  const opTypes = trail.map((t) => t.type);
  const sources = trail.map((t) => t.source);
  const totalLatencyMs = trail.reduce((sum, t) => sum + t.latencyMs, 0);
  const fingerprint = fnv1a(opTypes.join("|"));
  return {
    opTypes: Object.freeze(opTypes),
    sources: Object.freeze(sources),
    totalLatencyMs,
    fingerprint,
    crashClass,
    region,
  };
}

// ───────────────────────────────────────────────
// FNV-1a 32-bit hash — for crash fingerprinting
// ───────────────────────────────────────────────

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// ───────────────────────────────────────────────
// Replay test harness — the regression gate
// ───────────────────────────────────────────────

export interface ReplayTestResult {
  /** The skeleton that was replayed. */
  skeleton: CrashReplaySkeleton;
  /** Whether the replay reproduced the crash. */
  reproduced: boolean;
  /** Whether the current codebase is fixed (crash not reproduced). */
  fixed: boolean;
  /** Error message if the replay threw. */
  error: string | null;
}

/**
 * Run a crash replay against the current codebase. If the replay
 * reproduces the crash, the bug is still present (regression). If
 * it doesn't reproduce, the fix is confirmed.
 *
 * This is the property-test harness: take the op-type chain, apply
 * each op in sequence against a fresh doc, assert no invariant
 * violation. The real impl uses @supa/design-model's apply + validate
 * + the crash taxonomy's invariant checker.
 */
export function runCrashReplay(
  skeleton: CrashReplaySkeleton,
  applyOp: (opType: string, source: string) => void,
): ReplayTestResult {
  try {
    for (let i = 0; i < skeleton.opTypes.length; i++) {
      applyOp(skeleton.opTypes[i]!, skeleton.sources[i]!);
    }
    return {
      skeleton,
      reproduced: false,
      fixed: true,
      error: null,
    };
  } catch (err) {
    return {
      skeleton,
      reproduced: true,
      fixed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
