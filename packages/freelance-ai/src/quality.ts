/**
 * @supa/freelance-ai/quality
 * ----------------------------------------------------------------
 * Aggregations over the ai-quality channel, per verb × model ×
 * prompt version:
 *   • accept rate (used vs discarded)
 *   • edit distance distribution
 *   • downstream outcome (proposal → hire rate; capture → job
 *     published without structural fixes)
 *   • cost per accepted draft (tokens + latency — the model
 *     that's cheap but always discarded is expensive)
 *
 * Rule from sprint 1 applied: no benchmark number is shown
 * anywhere in-product. This scorecard is internal, ops-facing,
 * and exists to drive model/prompt swaps with evidence.
 * A/B: two prompt versions get tagged traffic; the channel
 * decides; swaps are facts recorded in ops, reversible.
 * ----------------------------------------------------------------
 */

import { z } from "zod";
import type { Draft } from "./verbs.js";

// ───────────────────────────────────────────────
// Per-draft cost (added to the provenance pipeline)
// ───────────────────────────────────────────────

export interface DraftCost {
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /** Cost in microcredits (from the credit ledger). */
  costMicrocredits: number;
}

// ───────────────────────────────────────────────
// Scorecard — per verb × model × promptVersion
// ───────────────────────────────────────────────

export const VerbScorecard = z.object({
  verbId: z.string(),
  modelId: z.string(),
  promptVersion: z.string(),
  // Accept rate (used / total).
  totalDrafts: z.number().int().nonnegative(),
  usedCount: z.number().int().nonnegative(),
  discardedCount: z.number().int().nonnegative(),
  acceptRate: z.number().min(0).max(1),
  // Edit distance distribution.
  avgEditDistance: z.number().min(0).max(1),
  medianEditDistance: z.number().min(0).max(1),
  p90EditDistance: z.number().min(0).max(1),
  // Downstream outcome (verb-specific).
  downstreamOutcome: z.object({
    // For proposal.draft: hire rate (hired / submitted).
    hireRate: z.number().min(0).max(1).nullable(),
    // For capture.*: job published without structural fixes.
    cleanCaptureRate: z.number().min(0).max(1).nullable(),
  }),
  // Cost per accepted draft (the model that's cheap but always
  // discarded is expensive — cost/accept is the real metric).
  totalCostMicrocredits: z.number().int().nonnegative(),
  costPerAccepted: z.number().nullable(),  // null if zero accepts
  avgLatencyMs: z.number(),
  // Internal-only flag (no benchmark shown in-product).
  internal: z.literal(true),
});
export type VerbScorecard = z.infer<typeof VerbScorecard>;

// ───────────────────────────────────────────────
// Build a scorecard from drafts + costs
// ───────────────────────────────────────────────

export interface DraftWithCost extends Draft {
  cost: DraftCost;
  // Downstream outcome (joined from supa-board for proposals, etc.).
  outcome?: "hired" | "rejected" | "withdrawn" | "published_clean" | "published_fixed" | "pending";
}

export function buildScorecard(
  drafts: readonly DraftWithCost[],
  verbId: string,
): VerbScorecard | null {
  const matching = drafts.filter((d) => d.provenance.verbId === verbId);
  if (matching.length === 0) return null;

  const firstDraft = matching[0];
  if (!firstDraft) return null;
  const modelId = firstDraft.provenance.modelId;
  const promptVersion = firstDraft.provenance.promptVersion;
  const used = matching.filter((d) => d.status === "used");
  const discarded = matching.filter((d) => d.status === "discarded");

  const acceptRate = matching.length > 0 ? used.length / matching.length : 0;

  // Edit distances for committed drafts.
  const editDistances = used.map((d) => {
    const draftLen = d.output.length;
    const editedLen = (d.editedOutput ?? d.output).length;
    const maxLen = Math.max(draftLen, editedLen);
    if (maxLen === 0) return 0;
    let matches = 0;
    for (let i = 0; i < Math.min(draftLen, editedLen); i++) {
      const editedOutput = d.editedOutput ?? d.output;
      if (d.output[i] === editedOutput[i]) matches++;
    }
    return 1 - matches / maxLen;
  });

  const avgEditDistance = editDistances.length > 0
    ? editDistances.reduce((a, b) => a + b, 0) / editDistances.length
    : 0;
  const sorted = [...editDistances].sort((a, b) => a - b);
  const medianEditDistance = sorted.length > 0
    ? sorted[Math.floor(sorted.length / 2)] ?? 0
    : 0;
  const p90EditDistance = sorted.length > 0
    ? sorted[Math.floor(sorted.length * 0.9)] ?? 0
    : 0;

  // Downstream outcome.
  const proposalDrafts = matching.filter((d) => d.outcome !== undefined);
  const hired = proposalDrafts.filter((d) => d.outcome === "hired").length;
  const submitted = proposalDrafts.filter((d) =>
    d.outcome === "hired" || d.outcome === "rejected" || d.outcome === "withdrawn"
  ).length;
  const hireRate = submitted > 0 ? hired / submitted : null;

  const captureDrafts = matching.filter((d) =>
    d.outcome === "published_clean" || d.outcome === "published_fixed"
  );
  const cleanCaptures = captureDrafts.filter((d) => d.outcome === "published_clean").length;
  const cleanCaptureRate = captureDrafts.length > 0 ? cleanCaptures / captureDrafts.length : null;

  // Cost.
  const totalCostMicrocredits = matching.reduce((sum, d) => sum + d.cost.costMicrocredits, 0);
  const costPerAccepted = used.length > 0 ? totalCostMicrocredits / used.length : null;
  const avgLatencyMs = matching.length > 0
    ? matching.reduce((sum, d) => sum + d.cost.latencyMs, 0) / matching.length
    : 0;

  return VerbScorecard.parse({
    verbId,
    modelId,
    promptVersion,
    totalDrafts: matching.length,
    usedCount: used.length,
    discardedCount: discarded.length,
    acceptRate: Math.round(acceptRate * 1000) / 1000,
    avgEditDistance: Math.round(avgEditDistance * 1000) / 1000,
    medianEditDistance: Math.round(medianEditDistance * 1000) / 1000,
    p90EditDistance: Math.round(p90EditDistance * 1000) / 1000,
    downstreamOutcome: {
      ...(hireRate !== null ? { hireRate: Math.round(hireRate * 1000) / 1000 } : { hireRate: null }),
      ...(cleanCaptureRate !== null ? { cleanCaptureRate: Math.round(cleanCaptureRate * 1000) / 1000 } : { cleanCaptureRate: null }),
    },
    totalCostMicrocredits,
    ...(costPerAccepted !== null ? { costPerAccepted: Math.round(costPerAccepted) } : { costPerAccepted: null }),
    avgLatencyMs: Math.round(avgLatencyMs),
    internal: true as const,
  });
}

// ───────────────────────────────────────────────
// A/B traffic splitter — two prompt versions get tagged traffic
// ───────────────────────────────────────────────

export interface ABTest {
  verbId: string;
  variantA: { promptVersion: string; trafficPercent: number };
  variantB: { promptVersion: string; trafficPercent: number };
  startedAt: number;
  // Min drafts before evaluating (the channel decides, not a human).
  minSampleSize: number;
}

/**
 * Assign traffic to variant A or B. Sticky per wsId (same workspace
 * sees the same variant across runs — measures the variant's effect,
 * not noise). Same FNV-1a pattern as the canary gate's cohort
 * assignment.
 */
export function assignABVariant(
  wsId: string,
  test: ABTest,
): "A" | "B" {
  const hash = fnv1a(`${wsId}:${test.verbId}`);
  const threshold = Math.floor(test.variantA.trafficPercent * 0x100000000);
  return hash < threshold ? "A" : "B";
}

/**
 * Evaluate the A/B test: compare scorecards for both variants.
 * Returns the winner (or "inconclusive" if below minSampleSize).
 */
export function evaluateABTest(
  test: ABTest,
  scorecardA: VerbScorecard | null,
  scorecardB: VerbScorecard | null,
): {
  winner: "A" | "B" | "inconclusive";
  reason: string;
} {
  if (!scorecardA || !scorecardB) {
    return { winner: "inconclusive", reason: "one or both scorecards are missing" };
  }
  if (scorecardA.totalDrafts < test.minSampleSize || scorecardB.totalDrafts < test.minSampleSize) {
    return { winner: "inconclusive", reason: "below minSampleSize" };
  }

  // The winner has higher accept rate + lower edit distance.
  // If accept rates are within 5pp, the tiebreaker is edit distance.
  const acceptDelta = scorecardA.acceptRate - scorecardB.acceptRate;
  if (Math.abs(acceptDelta) > 0.05) {
    const winner = acceptDelta > 0 ? "A" : "B";
    return {
      winner,
      reason: `accept rate: A=${(scorecardA.acceptRate * 100).toFixed(1)}% B=${(scorecardB.acceptRate * 100).toFixed(1)}% — ${winner} wins by ${Math.abs(acceptDelta * 100).toFixed(1)}pp`,
    };
  }

  const editDelta = scorecardA.avgEditDistance - scorecardB.avgEditDistance;
  const winner = editDelta < 0 ? "A" : "B";
  return {
    winner,
    reason: `accept rates within 5pp; edit distance: A=${scorecardA.avgEditDistance.toFixed(3)} B=${scorecardB.avgEditDistance.toFixed(3)} — ${winner} wins (lower edit distance)`,
  };
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}
