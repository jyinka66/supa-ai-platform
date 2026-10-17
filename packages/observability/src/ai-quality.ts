/**
 * @supa/observability/ai-quality
 * ----------------------------------------------------------------
 * AI sampling without review fatigue.
 *
 *   - 2% of generations snapshot (prompt template id + constrained-op
 *     output + anonymous screenshot) into a review queue.
 *
 *   - implicit signal: undo-rate within 10s of an AI op, and
 *     accept-without-edit vs edited-after-accept. These are the
 *     quality KPIs per model/prompt version — when we change a
 *     prompt, these numbers move or the change didn't matter.
 *
 *   - explicit thumbs up/down on AI results feeds the same queue at
 *     full retention.
 *
 * Prompt changes ship like code: evaluated against the 200-doc
 * benchmark corpus (from design-ai pass) before rollout.
 * ----------------------------------------------------------------
 */

import type { TelemetryClient } from "./telemetry.js";

// ───────────────────────────────────────────────
// Quality KPIs (per model + prompt version)
// ───────────────────────────────────────────────

export interface AiQualityKpis {
  /** Generation count in window. */
  generations: number;
  /** Undo within 10s / generations. The headline quality KPI. */
  undoRate10s: number;
  /** User pressed "accept" without further edits / accepts. */
  acceptWithoutEditRate: number;
  /** User pressed "accept" then edited within 60s / accepts. */
  editedAfterAcceptRate: number;
  /** Explicit thumbs down / (thumbs up + thumbs down). */
  thumbsDownRate: number;
  /** Average wall-time from accept to first manual edit (ms). */
  medianMsToFirstEdit: number;
}

// ───────────────────────────────────────────────
// Review queue event schema
// ───────────────────────────────────────────────

export type ReviewSource = "sampled" | "thumbs-down" | "thumbs-up";

export interface ReviewQueueEvent {
  /** Stable event id. */
  eventId: string;
  /** When generation finished. */
  ts: number;
  /** Doc id (no content ever leaves the client beyond the screenshot). */
  docId: string;
  /** Prompt template id (e.g., "ai.layout.suggest.v3"). */
  promptTemplateId: string;
  /** Model + provider tags for slicing. */
  model: string;
  provider: string;
  /** Constrained-op output — the command discriminator only, not payload. */
  outputOpTypes: string[];
  /** Anonymous screenshot — base64 PNG, already stripped of any text layer
   *  by the editor's capture path. Review queue retention is 7d. */
  screenshot?: string;
  /** Why this event landed in the queue. */
  source: ReviewSource;
  /** Build hash. */
  bundleVersion: string;
}

// ───────────────────────────────────────────────
// Implicit signal capture
// ───────────────────────────────────────────────

export interface GenerationAcceptedSignal {
  /** Generation event id from the AI pipeline. */
  generationId: string;
  /** Doc id. */
  docId: string;
  /** Prompt template id + model tags (carried for KPI attribution). */
  promptTemplateId: string;
  model: string;
  provider: string;
  /** Client clock at accept (ms). */
  acceptedAt: number;
}

export interface UndoSignal {
  /** Doc id where undo happened. */
  docId: string;
  /** Whether the undone op was an AI op (set by store). */
  undoneWasAiOp: boolean;
  /** The generation id of the AI op being undone, if known. */
  generationId?: string;
  ts: number;
}

export interface ManualEditSignal {
  /** Doc id where edit happened. */
  docId: string;
  /** Generation id whose accept preceded this edit (within 60s window). */
  precedingGenerationId?: string;
  ts: number;
}

// ───────────────────────────────────────────────
// AIQualityTracker
// ───────────────────────────────────────────────

export interface AIQualityTrackerOptions {
  telemetry: TelemetryClient;
  /** Build hash. */
  bundleVersion: string;
  /** Review queue endpoint (POST). */
  reviewEndpoint?: string;
  /** Sampling rate for the 2% review queue. Default 0.02. */
  sampleRate?: number;
  /** Override fetch (tests). */
  fetch?: typeof fetch;
  /** Override clock. */
  now?: () => number;
  /** Override random (tests). */
  random?: () => number;
}

interface PendingAccept {
  generationId: string;
  docId: string;
  promptTemplateId: string;
  model: string;
  provider: string;
  acceptedAt: number;
  editedAfterAccept: boolean;
}

const UNDO_WINDOW_MS = 10_000;
const EDIT_AFTER_ACCEPT_WINDOW_MS = 60_000;

export class AIQualityTracker {
  private readonly telemetry: TelemetryClient;
  private readonly bundleVersion: string;
  private readonly reviewEndpoint: string;
  private readonly sampleRate: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly random: () => number;

  /** Pending accepts keyed by generationId; cleaned up after 60s. */
  private readonly pending = new Map<string, PendingAccept>();

  /** KPI counters per (promptTemplateId, model, provider). */
  private readonly kpi = new Map<string, KpiAccumulator>();

  /** Thumbs signals (full retention since they're explicit). */
  private thumbsUp = 0;
  private thumbsDown = 0;

  constructor(opts: AIQualityTrackerOptions) {
    this.telemetry = opts.telemetry;
    this.bundleVersion = opts.bundleVersion;
    this.reviewEndpoint = opts.reviewEndpoint ?? "/api/observability/ai-review";
    this.sampleRate = opts.sampleRate ?? 0.02;
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
  }

  // ─────────── generation finished ───────────

  /**
   * Called when the AI pipeline emits an accepted op. Rolls the 2%
   * sample dice independently for the review queue. Then sets up the
   * pending accept tracking for implicit signal capture.
   */
  onGenerationAccepted(signal: GenerationAcceptedSignal): void {
    // 2% review queue sampling — independent of any implicit signal.
    if (this.random() < this.sampleRate) {
      this.enqueueReview({
        eventId: signal.generationId,
        ts: signal.acceptedAt,
        docId: signal.docId,
        promptTemplateId: signal.promptTemplateId,
        model: signal.model,
        provider: signal.provider,
        // Editor fills outputOpTypes when it calls onGenerationOutput();
        // for the sampled path we still want them, so editor should
        // pass them via onGenerationOutput() before calling accept.
        outputOpTypes: this.outputOpTypesFor(signal.generationId),
        source: "sampled",
        bundleVersion: this.bundleVersion,
      });
    }

    this.pending.set(signal.generationId, {
      ...signal,
      editedAfterAccept: false,
    });
    this.bumpKpi(signal, (k) => k.generations++);

    // Schedule cleanup past the edit-window.
    setTimeout(() => {
      this.finalizePending(signal.generationId);
    }, EDIT_AFTER_ACCEPT_WINDOW_MS + 1_000);
  }

  /** Called by the editor when the AI pipeline emits its op chain. */
  onGenerationOutput(generationId: string, opTypes: string[]): void {
    this.outputOps.set(generationId, opTypes);
  }
  private readonly outputOps = new Map<string, string[]>();

  // ─────────── undo ───────────

  /**
   * Called from store subscription when an undo happens. If the
   * undone op was an AI op AND it's still within 10s of accept, bump
   * the undo-rate KPI for that generation's (template, model).
   */
  onUndo(signal: UndoSignal): void {
    if (!signal.undoneWasAiOp) return;

    const pending = signal.generationId
      ? this.pending.get(signal.generationId)
      : this.findPendingByDoc(signal.docId);

    if (!pending) return;

    if (signal.ts - pending.acceptedAt <= UNDO_WINDOW_MS) {
      this.bumpKpi(pending, (k) => k.undosWithin10s++);
    }
  }

  // ─────────── manual edit after accept ───────────

  /**
   * Called from store subscription when a manual edit (non-AI op)
   * happens. If it's within 60s of an accept on the same doc, mark
   * that accept as edited-after.
   */
  onManualEdit(signal: ManualEditSignal): void {
    const pending = signal.precedingGenerationId
      ? this.pending.get(signal.precedingGenerationId)
      : this.findPendingByDoc(signal.docId);

    if (!pending) return;
    if (signal.ts - pending.acceptedAt > EDIT_AFTER_ACCEPT_WINDOW_MS) return;

    pending.editedAfterAccept = true;
    this.bumpKpi(pending, (k) => k.editedAfterAccept++);
    // Record ms-to-first-edit for median.
    const delta = signal.ts - pending.acceptedAt;
    this.bumpKpi(pending, (k) => {
      k.msToFirstEdit.push(delta);
    });
  }

  // ─────────── explicit thumbs ───────────

  /** Explicit feedback. Full retention into review queue. */
  onThumbs(
    direction: "up" | "down",
    ctx: {
      generationId: string;
      docId: string;
      promptTemplateId: string;
      model: string;
      provider: string;
    },
  ): void {
    if (direction === "up") this.thumbsUp++;
    else this.thumbsDown++;

    this.enqueueReview({
      eventId: ctx.generationId,
      ts: this.now(),
      docId: ctx.docId,
      promptTemplateId: ctx.promptTemplateId,
      model: ctx.model,
      provider: ctx.provider,
      outputOpTypes: this.outputOps.get(ctx.generationId) ?? [],
      source: direction === "up" ? "thumbs-up" : "thumbs-down",
      bundleVersion: this.bundleVersion,
    });
  }

  // ─────────── KPI snapshot ───────────

  /**
   * Snapshot + reset KPIs. The caller ships these to the warehouse
   * on a heartbeat cadence (typically 5 min). KPIs are NOT subject
   * to sampling — they're aggregates, computed from 100% of signals.
   */
  drainKpis(): AiQualityKpis[] {
    const out: AiQualityKpis[] = [];
    for (const acc of this.kpi.values()) {
      out.push(acc.toKpi());
    }
    this.kpi.clear();
    return out;
  }

  // ─────────── internals ───────────

  private findPendingByDoc(docId: string): PendingAccept | undefined {
    // Most-recent-first heuristic; if there are multiple, we attribute
    // to the latest accept (which is what the user just did).
    let latest: PendingAccept | undefined;
    for (const p of this.pending.values()) {
      if (p.docId === docId && (!latest || p.acceptedAt > latest.acceptedAt)) {
        latest = p;
      }
    }
    return latest;
  }

  private finalizePending(generationId: string): void {
    const pending = this.pending.get(generationId);
    if (!pending) return;
    // Tally accept-without-edit if no edit landed.
    if (!pending.editedAfterAccept) {
      this.bumpKpi(pending, (k) => k.acceptsWithoutEdit++);
    }
    this.bumpKpi(pending, (k) => k.accepts++);
    this.pending.delete(generationId);
    this.outputOps.delete(generationId);
  }

  private bumpKpi(
    sig: { promptTemplateId: string; model: string; provider: string },
    fn: (k: KpiAccumulator) => void,
  ): void {
    const key = `${sig.promptTemplateId}|${sig.model}|${sig.provider}`;
    let acc = this.kpi.get(key);
    if (!acc) {
      acc = new KpiAccumulator(sig.promptTemplateId, sig.model, sig.provider);
      this.kpi.set(key, acc);
    }
    fn(acc);
  }

  private outputOpTypesFor(generationId: string): string[] {
    return this.outputOps.get(generationId) ?? [];
  }

  private async enqueueReview(ev: ReviewQueueEvent): Promise<void> {
    try {
      await this.fetchImpl(this.reviewEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ev),
        keepalive: true,
      });
    } catch {
      /* swallow — review queue is best-effort */
    }
  }
}

// ───────────────────────────────────────────────
// KPI accumulator (100% sample, server-aggregated)
// ───────────────────────────────────────────────

class KpiAccumulator {
  generations = 0;
  undosWithin10s = 0;
  accepts = 0;
  acceptsWithoutEdit = 0;
  editedAfterAccept = 0;
  msToFirstEdit: number[] = [];

  constructor(
    readonly promptTemplateId: string,
    readonly model: string,
    readonly provider: string,
  ) {}

  toKpi(): AiQualityKpis {
    const g = Math.max(1, this.generations);
    const a = Math.max(1, this.accepts);
    return {
      generations: this.generations,
      undoRate10s: round(this.undosWithin10s / g),
      acceptWithoutEditRate: round(this.acceptsWithoutEdit / a),
      editedAfterAcceptRate: round(this.editedAfterAccept / a),
      thumbsDownRate: 0, // thumbs are tracked separately (see drainKpis caller)
      medianMsToFirstEdit: median(this.msToFirstEdit),
    };
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
    : Math.round(sorted[mid]!);
}

// ───────────────────────────────────────────────
// Prompt-change benchmark gate
// ───────────────────────────────────────────────

/**
 * Prompt changes ship like code. Before rollout, a candidate prompt
 * is evaluated against the 200-doc benchmark corpus (defined in
 * @supa/design-ai). This gate runs locally and on CI.
 *
 * Contract: the benchmark suite returns per-doc KPIs; this module
 * just enforces the regression thresholds. A prompt change may ship
 * if and only if:
 *   - undoRate10s does not increase by more than 1pp absolute
 *   - acceptWithoutEditRate does not decrease by more than 2pp absolute
 *   - medianMsToFirstEdit does not increase by more than 20%
 *
 * The thresholds are intentionally tight — if a prompt change can't
 * beat these bars, it didn't matter and we shouldn't ship the churn.
 */
export interface BenchmarkResult {
  promptTemplateId: string;
  baselineKpis: AiQualityKpis;
  candidateKpis: AiQualityKpis;
}

export interface BenchmarkGateResult {
  passed: boolean;
  failures: string[];
}

const THRESHOLDS = {
  undoRate10sDeltaAbs: 0.01,
  acceptWithoutEditDeltaAbs: 0.02,
  medianMsToFirstEditRel: 0.2,
};

export function evaluateBenchmarkGate(result: BenchmarkResult): BenchmarkGateResult {
  const failures: string[] = [];
  const { baselineKpis: b, candidateKpis: c } = result;

  const undoDelta = c.undoRate10s - b.undoRate10s;
  if (undoDelta > THRESHOLDS.undoRate10sDeltaAbs) {
    failures.push(
      `undoRate10s regressed: ${b.undoRate10s} → ${c.undoRate10s} (Δ=${round(undoDelta)} > ${THRESHOLDS.undoRate10sDeltaAbs})`,
    );
  }

  const acceptDelta = b.acceptWithoutEditRate - c.acceptWithoutEditRate;
  if (acceptDelta > THRESHOLDS.acceptWithoutEditDeltaAbs) {
    failures.push(
      `acceptWithoutEditRate regressed: ${b.acceptWithoutEditRate} → ${c.acceptWithoutEditRate} (Δ=${round(acceptDelta)} > ${THRESHOLDS.acceptWithoutEditDeltaAbs})`,
    );
  }

  if (b.medianMsToFirstEdit > 0) {
    const editRel = (c.medianMsToFirstEdit - b.medianMsToFirstEdit) / b.medianMsToFirstEdit;
    if (editRel > THRESHOLDS.medianMsToFirstEditRel) {
      failures.push(
        `medianMsToFirstEdit regressed: ${b.medianMsToFirstEdit} → ${c.medianMsToFirstEdit} (rel=${round(editRel)} > ${THRESHOLDS.medianMsToFirstEditRel})`,
      );
    }
  }

  return { passed: failures.length === 0, failures };
}
