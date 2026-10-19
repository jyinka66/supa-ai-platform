/**
 * @supa/freelance-ai/milestones
 * ----------------------------------------------------------------
 * Milestone suggester — contract draft → proposed milestone split.
 *
 * The AI proposes; the sum-to-total rule (sprint 2) rejects
 * impossible splits at submit time. The AI can be wrong about
 * arithmetic; the machine cannot.
 * ----------------------------------------------------------------
 */

import { z } from "zod";
import { db } from "@supa/db";
import { activityFacts } from "@supa/db/schema";
import {
  Verb,
  buildProvenance,
  type DraftId,
  type DraftStore,
  type LlmClient,
} from "./verbs.js";
import { Money } from "@supa/freelance-core/job";

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
// Milestone suggest verb
// ───────────────────────────────────────────────

export const MILESTONE_SUGGEST_VERB: Verb = {
  id: "milestone.suggest",
  reads: ["contract_draft"],
  modelId: "gemini-1.5-flash",
  promptVersion: "milestone.suggest.v1",
  writes: "draft_only",
  qualityChannel: "ai.milestone.suggest",
};

// ───────────────────────────────────────────────
// Input — the contract draft the AI reads
// ───────────────────────────────────────────────

export const MilestoneSuggestInput = z.object({
  title: z.string(),
  brief: z.string(),
  totalAmount: Money,
  currency: z.string().length(3),
  deadline: z.string().datetime().nullable(),
  discipline: z.string(),
  // The freelancer's estimated hours for the full project.
  estimatedHours: z.number().int().min(1).optional(),
});
export type MilestoneSuggestInput = z.infer<typeof MilestoneSuggestInput>;

// ───────────────────────────────────────────────
// Output — proposed milestone split
// ───────────────────────────────────────────────

export const ProposedMilestone = z.object({
  title: z.string().min(1).max(200),
  amountMinor: z.number().int().nonnegative(),
  // Suggested deadline for this milestone (optional).
  suggestedDeadline: z.string().datetime().nullable(),
  // Why this milestone exists (the AI's reasoning — for the human to review).
  rationale: z.string().max(500),
});
export type ProposedMilestone = z.infer<typeof ProposedMilestone>;

export const MilestoneSuggestion = z.object({
  milestones: z.array(ProposedMilestone).min(1).max(10),
  // The AI's computed sum (the machine validates this against totalAmount).
  computedSumMinor: z.number().int(),
  // Whether the AI's sum matches the contract total.
  sumMatches: z.boolean(),
});
export type MilestoneSuggestion = z.infer<typeof MilestoneSuggestion>;

// ───────────────────────────────────────────────
// runMilestoneSuggest — generate a milestone split draft
// ───────────────────────────────────────────────

/**
 * Generate a milestone split proposal from a contract draft.
 *
 * The AI proposes; the sum-to-total rule rejects impossible splits
 * at submit time. The AI can be wrong about arithmetic; the machine
 * cannot. If the AI's sum doesn't match the contract total, the
 * suggestion is flagged with `sumMatches: false` — the human must
 * adjust before submitting.
 */
export async function runMilestoneSuggest(
  wsId: string,
  input: MilestoneSuggestInput,
  llm: LlmClient,
  drafts: DraftStore,
): Promise<{ draftId: DraftId; suggestion: MilestoneSuggestion }> {
  const verb = MILESTONE_SUGGEST_VERB;

  const rawOutput = await llm.complete(verb.modelId, verb.promptVersion, {
    title: input.title,
    brief: input.brief,
    totalAmount: input.totalAmount,
    currency: input.currency,
    deadline: input.deadline,
    discipline: input.discipline,
    estimatedHours: input.estimatedHours,
  });

  let suggestion: MilestoneSuggestion;
  try {
    const parsed: unknown = JSON.parse(rawOutput);
    const rawMilestones =
      parsed && typeof parsed === "object" && "milestones" in parsed
        ? (parsed as { milestones?: unknown }).milestones
        : undefined;
    const milestones = z.array(ProposedMilestone).min(1).max(10).parse(rawMilestones);
    const computedSum = milestones.reduce((sum, m) => sum + m.amountMinor, 0);
    suggestion = MilestoneSuggestion.parse({
      milestones,
      computedSumMinor: computedSum,
      sumMatches: computedSum === input.totalAmount.amountMinor,
    });
  } catch {
    suggestion = MilestoneSuggestion.parse({
      milestones: [{
        title: "Full Project",
        amountMinor: input.totalAmount.amountMinor,
        suggestedDeadline: input.deadline,
        rationale: "AI failed to parse milestone split — single milestone as fallback",
      }],
      computedSumMinor: input.totalAmount.amountMinor,
      sumMatches: true,
    });
  }

  const provenance = buildProvenance(verb);
  const draft = await drafts.insert({
    wsId,
    verbId: verb.id,
    inputRefs: verb.reads,
    output: JSON.stringify(suggestion),
    provenance,
    generatedAt: new Date().toISOString(),
  });

  await db.transaction(async (tx) => {
    await recordActivity(tx, {
      wsId,
      kind: "supa.ai.milestone.suggest",
      ref: {
        verbId: verb.id,
        draftId: draft.id,
        milestoneCount: suggestion.milestones.length,
        sumMatches: suggestion.sumMatches,
        computedSum: suggestion.computedSumMinor,
        expectedTotal: input.totalAmount.amountMinor,
      },
    });
  });

  return { draftId: draft.id, suggestion };
}

// ───────────────────────────────────────────────
// Sum validation — the machine cannot be wrong about arithmetic
// ───────────────────────────────────────────────

/**
 * Validate that the proposed milestones sum to the contract total.
 * If they don't, the human must adjust before submitting.
 * This is the "the AI can be wrong about arithmetic; the machine
 * cannot" rule, enforced at validation time.
 */
export function validateMilestoneSum(
  milestones: readonly ProposedMilestone[],
  totalAmountMinor: number,
): { valid: boolean; sum: number; delta: number } {
  const sum = milestones.reduce((acc, m) => acc + m.amountMinor, 0);
  const delta = sum - totalAmountMinor;
  return { valid: delta === 0, sum, delta };
}
