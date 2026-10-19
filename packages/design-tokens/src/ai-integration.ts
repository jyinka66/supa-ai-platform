/**
 * @supa/design-tokens/ai-integration
 * ----------------------------------------------------------------
 * design-ai's palette generation now emits TOKEN PROPOSALS, not raw
 * fills: "generated palette → apply as tokens [brand.primary,
 * surface.1...]?"
 *
 * Applying replaces token values (refs propagate everywhere
 * instantly) instead of repainting node-by-node — palette-on-800-
 * layers becomes one op batch, and the user can accept per-token,
 * not per-layer.
 *
 * Pass 1's repaint path remains for literal-bearing legacy docs;
 * extract-to-token is the suggested first action for them.
 *
 * ai-quality's implicit signals extend naturally: undo-rate on
 * token-apply vs literal-repaint is a direct KPI for whether
 * token-first UX is winning.
 * ----------------------------------------------------------------
 */

import type { VariantName } from "./schema.js";
import { computeTokenValueOps, type SetTokenValueOp } from "./bindings.js";

// ───────────────────────────────────────────────
// Token proposal shape
// ───────────────────────────────────────────────

export interface TokenProposal {
  /** Stable proposal id (for accept/reject tracking). */
  proposalId: string;
  /** Token id this proposal would set. */
  tokenId: string;
  /** Proposed value (literal). */
  value: string;
  /** Optional variant — if present, only the variant is changed. */
  variant?: VariantName;
  /** Human-readable rationale (shown in the inspector). */
  rationale?: string;
  /** Confidence (0..1) — for sorting proposals. */
  confidence?: number;
}

export interface TokenProposalBatch {
  /** Stable batch id (groups proposals from one AI generation). */
  batchId: string;
  /** AI generation id (for telemetry + provenance). */
  aiGenerationId: string;
  /** Op class that generated this batch. */
  opClass: "palette-suggest" | "repaint" | "template-generate";
  /** Model + provider tags (for telemetry). */
  model: string;
  provider: string;
  /** The proposals — user accepts per-token, not per-batch. */
  proposals: TokenProposal[];
}

// ───────────────────────────────────────────────
// Per-token accept (the headline UX win)
// ───────────────────────────────────────────────

export interface AcceptDecision {
  proposalId: string;
  accepted: boolean;
}

/**
 * Apply accepted proposals → produce SetTokenValue ops.
 *
 * The user can accept per-token, not per-layer. Accepted proposals
 * become SetTokenValue ops that update the token map; rejected
 * proposals are dropped (no ops). Refs propagate everywhere
 * instantly — palette-on-800-layers becomes one op batch.
 */
export function applyAcceptedProposals(
  batch: TokenProposalBatch,
  decisions: AcceptDecision[],
): SetTokenValueOp[] {
  const acceptedIds = new Set(
    decisions.filter((d) => d.accepted).map((d) => d.proposalId),
  );
  const accepted = batch.proposals.filter((p) => acceptedIds.has(p.proposalId));
  return computeTokenValueOps(
    accepted.map((p) => ({
      tokenId: p.tokenId,
      value: p.value,
      ...(p.variant ? { variant: p.variant } : {}),
    })),
  );
}

/**
 * Compute the "full repaint" alternative — what pass 1's repaint path
 * would have done. Returns the count of nodes that would have needed
 * per-node edits under the old model.
 *
 * This is the comparison signal for the token-first UX KPI:
 *   token-apply ops / literal-repaint node count
 * A ratio near 0 means token-first is winning (few ops, many nodes
 * updated); a ratio near 1 means literal repaint (one op per node).
 */
export function computeLiteralRepaintAlternative(
  /** Ref-bearing nodes that would have been repainted node-by-node. */
  refBearingNodeCount: number,
  /** Number of token-apply ops actually issued. */
  tokenApplyOps: number,
): {
  /** Token-first op count. */
  tokenOps: number;
  /** Literal-repaint node count (the old model). */
  literalRepaintNodes: number;
  /** Ratio: tokenOps / literalRepaintNodes. Lower is better. */
  ratio: number;
} {
  const ratio = refBearingNodeCount === 0 ? 0 : tokenApplyOps / refBearingNodeCount;
  return {
    tokenOps: tokenApplyOps,
    literalRepaintNodes: refBearingNodeCount,
    ratio: Math.round(ratio * 1000) / 1000,
  };
}

// ───────────────────────────────────────────────
// Undo-rate KPI bridge (feeds @supa/observability/ai-quality)
// ───────────────────────────────────────────────

/**
 * ai-quality's implicit signals extend naturally: undo-rate on
 * token-apply vs literal-repaint is a direct KPI for whether
 * token-first UX is winning.
 *
 * This bridge produces the per-batch signal that ai-quality's
 * AIQualityTracker records. The host process wires this to the
 * tracker's onGenerationAccepted() + onUndo() methods.
 */
export interface TokenApplyKpiSignal {
  /** Generation id (from the AI pipeline). */
  generationId: string;
  /** Token-first path was used (vs literal repaint). */
  tokenFirst: boolean;
  /** Number of proposals in the batch. */
  proposalCount: number;
  /** Number of proposals accepted (per-token accept). */
  acceptedCount: number;
  /** Number of token-apply ops issued. */
  tokenApplyOps: number;
  /** Number of ref-bearing nodes that would have been repainted. */
  refBearingNodeCount: number;
  /** Ratio (tokenOps / refBearingNodeCount). Lower = token-first winning. */
  ratio: number;
  /** Op class — for per-class KPI slicing. */
  opClass: "palette-suggest" | "repaint" | "template-generate";
  /** Model + provider — for per-model KPI slicing. */
  model: string;
  provider: string;
}

export function buildTokenApplyKpiSignal(
  batch: TokenProposalBatch,
  decisions: AcceptDecision[],
  refBearingNodeCount: number,
  tokenApplyOps: number,
): TokenApplyKpiSignal {
  const acceptedCount = decisions.filter((d) => d.accepted).length;
  const alt = computeLiteralRepaintAlternative(refBearingNodeCount, tokenApplyOps);
  return {
    generationId: batch.aiGenerationId,
    tokenFirst: true,
    proposalCount: batch.proposals.length,
    acceptedCount,
    tokenApplyOps,
    refBearingNodeCount,
    ratio: alt.ratio,
    opClass: batch.opClass,
    model: batch.model,
    provider: batch.provider,
  };
}

// ───────────────────────────────────────────────
// Legacy-doc detect (suggest extract-to-token first)
// ───────────────────────────────────────────────

/**
 * Pass 1's repaint path remains for literal-bearing legacy docs.
 * When the AI encounters a doc with mostly literals, it suggests
 * extract-to-token as the first action — converts literals to
 * refs in one batch op, then palette generation works token-first.
 */
export interface LegacyDocAssessment {
  /** Total bound fields (fill/space/radius/textStyle) in the doc. */
  totalFields: number;
  /** Fields that are literals (not refs). */
  literalFields: number;
  /** Fields that are refs. */
  refFields: number;
  /** True if the doc is mostly literals (literalRatio > 0.5). */
  isLegacy: boolean;
  /** Ratio of literals to total fields. */
  literalRatio: number;
  /** Suggested action: "extract-to-token" if legacy, "token-apply" otherwise. */
  suggestedAction: "extract-to-token" | "token-apply";
}

export function assessLegacyDoc(
  nodes: { fill?: { kind: string }; space?: { kind: string }; radius?: { kind: string }; textStyle?: { kind: string } }[],
): LegacyDocAssessment {
  let totalFields = 0;
  let literalFields = 0;
  let refFields = 0;
  for (const node of nodes) {
    for (const field of ["fill", "space", "radius", "textStyle"] as const) {
      const v = node[field];
      if (v) {
        totalFields++;
        if (v.kind === "literal") literalFields++;
        else if (v.kind === "ref") refFields++;
      }
    }
  }
  const literalRatio = totalFields === 0 ? 0 : literalFields / totalFields;
  const isLegacy = literalRatio > 0.5;
  return {
    totalFields,
    literalFields,
    refFields,
    isLegacy,
    literalRatio: Math.round(literalRatio * 1000) / 1000,
    suggestedAction: isLegacy ? "extract-to-token" : "token-apply",
  };
}

// ───────────────────────────────────────────────
// AI proposal generator (host-side, not LLM)
// ───────────────────────────────────────────────

/**
 * Convert a raw LLM palette output into token proposals. The LLM
 * emits colors (e.g. "#1a1aff"); this function maps them to
 * proposed token values for the given token ids.
 *
 * The host process calls this AFTER the constrained-op gate has
 * validated the LLM's output — so we know the LLM didn't emit
 * anything outside our schema.
 */
export function paletteToTokenProposals(
  palette: { colors: string[] },
  targetTokenIds: string[],
  ctx: { aiGenerationId: string; opClass: "palette-suggest" | "repaint"; model: string; provider: string },
): TokenProposalBatch {
  const proposals: TokenProposal[] = palette.colors.slice(0, targetTokenIds.length).flatMap((color, i) => {
    const tokenId = targetTokenIds[i];
    if (tokenId === undefined) return [];
    return [{
      proposalId: `${ctx.aiGenerationId}-p${String(i)}`,
      tokenId,
      value: color,
      confidence: 1 - i * 0.1, // first color is highest-confidence
    }];
  });
  return {
    batchId: ctx.aiGenerationId,
    aiGenerationId: ctx.aiGenerationId,
    opClass: ctx.opClass,
    model: ctx.model,
    provider: ctx.provider,
    proposals,
  };
}
