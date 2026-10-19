/**
 * @supa/freelance-ai/proposal
 * ----------------------------------------------------------------
 * Proposal generator — listing + freelancer profile facts → cover
 * letter draft. The AI proposes; the freelancer edits; the edit
 * distance is the quality signal.
 *
 * Win-rate-per-(model,prompt) joins this with the hire/reject
 * facts from @supa/supa-board — closed loop, queryable.
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

// ───────────────────────────────────────────────
// Proposal verb
// ───────────────────────────────────────────────

export const PROPOSAL_VERB: Verb = {
  id: "proposal.draft",
  reads: ["listing", "freelancer_profile"],
  modelId: "gemini-1.5-flash",
  promptVersion: "proposal.draft.v1",
  writes: "draft_only",
  qualityChannel: "ai.proposal.draft",
};

// ───────────────────────────────────────────────
// Proposal input — what the AI reads
// ───────────────────────────────────────────────

export const ProposalInput = z.object({
  listing: z.object({
    title: z.string(),
    brief: z.string(),
    discipline: z.string(),
    skills: z.array(z.string()),
    budget: z.object({ value: z.any(), type: z.enum(["hourly", "fixed"]) }),
  }),
  freelancerProfile: z.object({
    headline: z.string(),
    bio: z.string(),
    skills: z.array(z.string()),
    completedContracts: z.number().int(),
    byDiscipline: z.array(z.object({
      discipline: z.string(),
      completed: z.number().int(),
    })),
  }),
  // The freelancer's rate for this proposal (their choice, not AI's).
  proposedRate: z.object({ value: z.any(), type: z.enum(["hourly", "fixed"]) }),
  proposedDays: z.number().int().min(1).max(365),
});
export type ProposalInput = z.infer<typeof ProposalInput>;

// ───────────────────────────────────────────────
// Proposal output — the generated cover letter draft
// ───────────────────────────────────────────────

export const ProposalDraft = z.object({
  coverLetter: z.string().max(10_000),
  // Which skills the AI chose to highlight (for quality measurement).
  highlightedSkills: z.array(z.string()),
  // Which past contracts the AI referenced (for provenance).
  referencedDisciplines: z.array(z.string()),
  // Confidence in the match quality (the AI's self-assessment, not the truth).
  matchConfidence: z.number().min(0).max(1),
});
export type ProposalDraft = z.infer<typeof ProposalDraft>;

// ───────────────────────────────────────────────
// runProposal — generate a cover letter draft
// ───────────────────────────────────────────────

/**
 * Generate a proposal cover letter draft from a listing + freelancer profile.
 *
 * The AI reads the listing brief, the freelancer's profile (headline,
 * bio, skills, completed contracts by discipline), and the freelancer's
 * proposed rate + timeline. It outputs a cover letter draft.
 *
 * The draft is NEVER auto-submitted — the freelancer reviews + edits +
 * commits. The edit distance between draft and final is the quality
 * signal. Win-rate-per-(model,prompt) joins with hire/reject facts.
 */
export async function runProposal(
  wsId: string,
  input: ProposalInput,
  llm: LlmClient,
  drafts: DraftStore,
): Promise<{ draftId: DraftId; proposal: ProposalDraft }> {
  const verb = PROPOSAL_VERB;

  const rawOutput = await llm.complete(verb.modelId, verb.promptVersion, {
    listing: input.listing,
    freelancerProfile: input.freelancerProfile,
    proposedRate: input.proposedRate,
    proposedDays: input.proposedDays,
  });

  let proposal: ProposalDraft;
  try {
    proposal = ProposalDraft.parse(JSON.parse(rawOutput));
  } catch {
    // Fallback: use raw output as the cover letter.
    proposal = ProposalDraft.parse({
      coverLetter: rawOutput.slice(0, 10_000),
      highlightedSkills: [],
      referencedDisciplines: [],
      matchConfidence: 0,
    });
  }

  const provenance = buildProvenance(verb);
  const draft = await drafts.insert({
    wsId,
    verbId: verb.id,
    inputRefs: verb.reads,
    output: JSON.stringify(proposal),
    provenance,
    generatedAt: new Date().toISOString(),
  });

  await db.transaction(async (tx) => {
    await recordActivity(tx, {
      wsId,
      kind: "supa.ai.proposal.draft",
      ref: {
        verbId: verb.id,
        draftId: draft.id,
        listingTitle: input.listing.title,
        matchConfidence: proposal.matchConfidence,
        highlightedSkills: proposal.highlightedSkills,
      },
    });
  });

  return { draftId: draft.id, proposal };
}

// ───────────────────────────────────────────────
// Proposal quality — win-rate per (model, prompt) version
// ───────────────────────────────────────────────

export interface ProposalQualitySignal {
  verbId: string;
  modelId: string;
  promptVersion: string;
  // From the draft:
  matchConfidence: number;
  highlightedSkills: string[];
  // From the commit (edit distance):
  editDistance: number;
  // From the outcome (joined with supa-board hire/reject facts):
  outcome: "hired" | "rejected" | "withdrawn" | "pending";
  timeToOutcomeMs: number | null;
}

/**
 * Build the quality signal for a proposal, joining the draft's edit
 * distance with the application outcome from @supa/supa-board.
 *
 * This is the closed loop: the AI proposes, the freelancer edits,
 * the client hires or rejects. The quality signal per (model, prompt)
 * version is the win rate — and it's queryable from the same fact
 * table, no extra logging of content.
 */
export function buildProposalQualitySignal(
  draft: { provenance: { verbId: string; modelId: string; promptVersion: string } },
  editDistance: number,
  matchConfidence: number,
  outcome: ProposalQualitySignal["outcome"],
  submittedAt: number,
  decidedAt: number | null,
): ProposalQualitySignal {
  return {
    verbId: draft.provenance.verbId,
    modelId: draft.provenance.modelId,
    promptVersion: draft.provenance.promptVersion,
    matchConfidence,
    highlightedSkills: [],
    editDistance,
    outcome,
    timeToOutcomeMs: decidedAt !== null ? decidedAt - submittedAt : null,
  };
}
