/**
 * @supa/freelance-ai/quality-loop
 * ----------------------------------------------------------------
 * The feedback loop that closes. Quality signals (edit distance,
 * discard rate, win rate) are recorded on every draft — but they
 * were never fed back. This module does the feeding:
 *
 *   1. Collects quality signals per (verbId, modelId, promptVersion).
 *   2. Evaluates against thresholds (edit distance, discard rate, win rate).
 *   3. Flags failing (model, prompt) pairs for prompt revision.
 *   4. Emits a "quality alert" activity fact — same discipline as the
 *      canary gate in @supa/observability: a human reads the why,
 *      not the whether.
 *
 * A prompt version that produces heavily-edited drafts keeps running
 * until this gate catches it. The gate is the automated half of
 * the prompt-change benchmark gate from @supa/observability/ai-quality.
 * ----------------------------------------------------------------
 */

import { z } from "zod";
import { db } from "@supa/db";
import { activityFacts } from "@supa/db/schema";
import type { Draft, DraftOutcome } from "./verbs.js";

async function recordActivity(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: { wsId: string; kind: string; ref: Record<string, unknown> },
): Promise<void> {
  await tx.insert(activityFacts).values({
    workspaceId: input.wsId,
    kind: input.kind,
    refId: JSON.stringify(input.ref),
    occurredAt: new Date(),
    actor: "system",
    source: "system",
  });
}

// ───────────────────────────────────────────────
// Quality thresholds — the gate
// ───────────────────────────────────────────────

export interface QualityThresholds {
  /** Min drafts before evaluating (too few = noise). */
  minSampleSize: number;
  /** Avg edit distance above this → flag (0..1, 1 = fully rewritten). */
  maxAvgEditDistance: number;
  /** Discard rate above this → flag (0..1). */
  maxDiscardRate: number;
  /** Win rate below this → flag (proposal.draft only, 0..1). */
  minWinRate: number;
}

export const DEFAULT_THRESHOLDS: QualityThresholds = {
  minSampleSize: 10,
  maxAvgEditDistance: 0.7,
  maxDiscardRate: 0.4,
  minWinRate: 0.15,
};

// ───────────────────────────────────────────────
// Quality aggregate — per (verbId, modelId, promptVersion)
// ───────────────────────────────────────────────

export interface QualityAggregate {
  verbId: string;
  modelId: string;
  promptVersion: string;
  totalDrafts: number;
  committedCount: number;
  discardedCount: number;
  avgEditDistance: number;
  /** Win rate for proposal.draft (hired / submitted). Null for other verbs. */
  winRate: number | null;
}

export function aggregateQuality(
  drafts: readonly Draft[],
  verbId: string,
  outcomes?: ReadonlyMap<string, DraftOutcome>,
): QualityAggregate | null {
  const matching = drafts.filter((d) => d.provenance.verbId === verbId);
  if (matching.length === 0) return null;

  const committed = matching.filter((d) => d.status === "used");
  const discarded = matching.filter((d) => d.status === "discarded");

  // Edit distance for committed drafts.
  const editDistances = committed.map((d) => {
    const draftLen = d.output.length;
    const editedLen = (d.editedOutput ?? d.output).length;
    const maxLen = Math.max(draftLen, editedLen);
    if (maxLen === 0) return 0;
    let matches = 0;
    for (let i = 0; i < Math.min(draftLen, editedLen); i++) {
      if (d.output[i] === d.editedOutput![i]) matches++;
    }
    return 1 - matches / maxLen;
  });
  const avgEditDistance = editDistances.length > 0
    ? editDistances.reduce((a, b) => a + b, 0) / editDistances.length
    : 0;

  // Win rate is only meaningful for proposal.draft (hired / submitted
  // — submitted = hired + rejected from the outcomes map). When no
  // outcomes map is provided, win rate stays null (the historical
  // behavior) — callers that haven't wired outcomes yet degrade
  // gracefully instead of being silently stuck at null forever.
  let winRate: number | null = null;
  if (verbId === "proposal.draft" && outcomes && outcomes.size > 0) {
    let hired = 0;
    let resolved = 0;
    for (const d of matching) {
      const outcome = outcomes.get(d.id);
      if (outcome === "hired") {
        hired++;
        resolved++;
      } else if (outcome === "rejected") {
        resolved++;
      }
    }
    winRate = resolved > 0 ? Math.round((hired / resolved) * 1000) / 1000 : null;
  }

  return {
    verbId,
    modelId: matching[0]!.provenance.modelId,
    promptVersion: matching[0]!.provenance.promptVersion,
    totalDrafts: matching.length,
    committedCount: committed.length,
    discardedCount: discarded.length,
    avgEditDistance: Math.round(avgEditDistance * 1000) / 1000,
    winRate,
  };
}

// ───────────────────────────────────────────────
// Quality evaluation — the gate check
// ───────────────────────────────────────────────

export type QualityVerdict = "passing" | "flagged" | "insufficient_sample";

export interface QualityEvaluation {
  aggregate: QualityAggregate;
  verdict: QualityVerdict;
  failures: string[];
  recommendation: string | null;
}

export function evaluateQuality(
  aggregate: QualityAggregate,
  thresholds: QualityThresholds = DEFAULT_THRESHOLDS,
): QualityEvaluation {
  const failures: string[] = [];

  if (aggregate.totalDrafts < thresholds.minSampleSize) {
    return {
      aggregate,
      verdict: "insufficient_sample",
      failures: [],
      recommendation: `only ${aggregate.totalDrafts} drafts — need ${thresholds.minSampleSize} before evaluating`,
    };
  }

  if (aggregate.avgEditDistance > thresholds.maxAvgEditDistance) {
    failures.push(
      `avg edit distance ${aggregate.avgEditDistance} exceeds threshold ${thresholds.maxAvgEditDistance} — drafts are heavily rewritten`,
    );
  }

  const discardRate = aggregate.discardedCount / aggregate.totalDrafts;
  if (discardRate > thresholds.maxDiscardRate) {
    failures.push(
      `discard rate ${Math.round(discardRate * 100)}% exceeds threshold ${Math.round(thresholds.maxDiscardRate * 100)}% — humans are throwing outputs away`,
    );
  }

  if (aggregate.winRate !== null && aggregate.winRate < thresholds.minWinRate) {
    failures.push(
      `win rate ${Math.round(aggregate.winRate * 100)}% below threshold ${Math.round(thresholds.minWinRate * 100)}% — proposals aren't converting`,
    );
  }

  const verdict: QualityVerdict = failures.length > 0 ? "flagged" : "passing";
  const recommendation = failures.length > 0
    ? `prompt version "${aggregate.promptVersion}" for verb "${aggregate.verbId}" should be revised — ${failures.length} quality failure(s)`
    : null;

  return { aggregate, verdict, failures, recommendation };
}

// ───────────────────────────────────────────────
// Quality report — the daily/weekly scan
// ───────────────────────────────────────────────

export interface QualityReport {
  runAt: string;
  evaluations: readonly QualityEvaluation[];
  flaggedCount: number;
  passingCount: number;
  insufficientCount: number;
}

/**
 * Run the quality feedback loop: scan all verbs' drafts, evaluate
 * each (verbId, modelId, promptVersion) pair against thresholds,
 * emit quality alerts for flagged pairs.
 *
 * Same discipline as the canary gate: a human reads the why (the
 * failures array), not the whether (the gate auto-flags). The
 * prompt author decides whether to revise — the gate surfaces the
 * data.
 */
export async function runQualityLoop(
  drafts: readonly Draft[],
  verbIds: readonly string[],
  thresholds: QualityThresholds = DEFAULT_THRESHOLDS,
  now: string = new Date().toISOString(),
  outcomes?: ReadonlyMap<string, DraftOutcome>,
): Promise<QualityReport> {
  const evaluations: QualityEvaluation[] = [];

  for (const verbId of verbIds) {
    const aggregate = aggregateQuality(drafts, verbId, outcomes);
    if (!aggregate) continue;
    evaluations.push(evaluateQuality(aggregate, thresholds));
  }

  // Emit quality alerts for flagged pairs.
  const flagged = evaluations.filter((e) => e.verdict === "flagged");
  if (flagged.length > 0) {
    await db.transaction(async (tx) => {
      for (const evaluation of flagged) {
        await recordActivity(tx, {
          wsId: "00000000-0000-0000-0000-000000000000", // platform ops workspace
          kind: "supa.ai.quality.flagged",
          ref: {
            verbId: evaluation.aggregate.verbId,
            modelId: evaluation.aggregate.modelId,
            promptVersion: evaluation.aggregate.promptVersion,
            failures: evaluation.failures,
            recommendation: evaluation.recommendation,
            totalDrafts: evaluation.aggregate.totalDrafts,
            avgEditDistance: evaluation.aggregate.avgEditDistance,
          },
        });
      }
    });
  }

  return {
    runAt: now,
    evaluations,
    flaggedCount: flagged.length,
    passingCount: evaluations.filter((e) => e.verdict === "passing").length,
    insufficientCount: evaluations.filter((e) => e.verdict === "insufficient_sample").length,
  };
}
