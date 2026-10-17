/**
 * @supa/freelance-ai/brief
 * ----------------------------------------------------------------
 * Brief summarizer — long brief → structured summary, shown
 * alongside (never replacing) the original. The summary is a
 * navigation aid, not a replacement; the original brief is always
 * the source of truth.
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

export const BRIEF_SUMMARIZE_VERB: Verb = {
  id: "brief.summarize",
  reads: ["job_brief"],
  modelId: "gemini-1.5-flash",
  promptVersion: "brief.summarize.v1",
  writes: "draft_only",
  qualityChannel: "ai.brief.summarize",
};

export const BriefSummary = z.object({
  // 3-5 bullet points, max 200 chars each.
  keyPoints: z.array(z.string().max(200)).min(1).max(5),
  // Extracted requirements (skills, deliverables, constraints).
  requirements: z.array(z.string()).max(20),
  // Extracted budget range (if mentioned in the brief).
  budgetHint: z.object({
    min: z.number().int().nonnegative().nullable(),
    max: z.number().int().nonnegative().nullable(),
    currency: z.string().length(3).nullable(),
    type: z.enum(["hourly", "fixed"]).nullable(),
  }).nullable(),
  // Extracted deadline (if mentioned).
  deadlineHint: z.string().datetime().nullable(),
  // Red flags the AI noticed (vague scope, unrealistic budget, etc.).
  redFlags: z.array(z.string()).max(10),
  // The AI's confidence that it captured the brief accurately.
  confidence: z.number().min(0).max(1),
});
export type BriefSummary = z.infer<typeof BriefSummary>;

/**
 * Generate a structured summary from a long brief.
 *
 * The summary is shown ALONGSIDE the original, never replacing it.
 * The original brief is always the source of truth; the summary is
 * a navigation aid for the freelancer scanning many listings.
 */
export async function runBriefSummarize(
  wsId: string,
  brief: string,
  llm: LlmClient,
  drafts: DraftStore,
): Promise<{ draftId: DraftId; summary: BriefSummary }> {
  const verb = BRIEF_SUMMARIZE_VERB;

  const rawOutput = await llm.complete(verb.modelId, verb.promptVersion, {
    brief,
  });

  let summary: BriefSummary;
  try {
    summary = BriefSummary.parse(JSON.parse(rawOutput));
  } catch {
    summary = BriefSummary.parse({
      keyPoints: ["AI failed to parse the brief — see original"],
      requirements: [],
      budgetHint: null,
      deadlineHint: null,
      redFlags: ["AI summary failed to parse"],
      confidence: 0,
    });
  }

  const provenance = buildProvenance(verb);
  const draft = await drafts.insert({
    wsId,
    verbId: verb.id,
    inputRefs: verb.reads,
    output: JSON.stringify(summary),
    provenance,
    generatedAt: new Date().toISOString(),
  });

  await db.transaction(async (tx) => {
    await recordActivity(tx, {
      wsId,
      kind: "supa.ai.brief.summarize",
      ref: {
        verbId: verb.id,
        draftId: draft.id,
        confidence: summary.confidence,
        keyPointCount: summary.keyPoints.length,
        redFlagCount: summary.redFlags.length,
      },
    });
  });

  return { draftId: draft.id, summary };
}
