/**
 * @supa/freelance-ai/delivery
 * ----------------------------------------------------------------
 * Work-delivery AI — AI-assisted deliverable generation. The verbs
 * produce the WORK itself (code, copy, design suggestions), not
 * just meta about the work. Same draft→edit→commit lifecycle.
 *
 * The quality signal here is the strongest: the freelancer's edit
 * distance on the actual deliverable. If the AI's code/copy is
 * lightly edited and the client approves the milestone, the verb
 * is working. If it's heavily rewritten or the milestone gets
 * "changes_requested", the verb is failing.
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
import { Discipline } from "@supa/freelance-core/job";

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
// Delivery verbs — per discipline
// ───────────────────────────────────────────────

export const DELIVERY_VERBS: readonly Verb[] = [
  {
    id: "deliver.writing_draft",
    reads: ["brief", "milestone_spec", "style_guide"],
    modelId: "gemini-1.5-pro",
    promptVersion: "deliver.writing.v1",
    writes: "draft_only",
    qualityChannel: "ai.deliver.writing",
  },
  {
    id: "deliver.code_scaffold",
    reads: ["brief", "milestone_spec", "tech_stack"],
    modelId: "gemini-1.5-pro",
    promptVersion: "deliver.code.v1",
    writes: "draft_only",
    qualityChannel: "ai.deliver.code",
  },
  {
    id: "deliver.copy_draft",
    reads: ["brief", "brand_guidelines", "target_audience"],
    modelId: "gemini-1.5-pro",
    promptVersion: "deliver.copy.v1",
    writes: "draft_only",
    qualityChannel: "ai.deliver.copy",
  },
  {
    id: "deliver.design_brief",
    reads: ["brief", "milestone_spec", "design_references"],
    modelId: "gemini-1.5-pro",
    promptVersion: "deliver.design.v1",
    writes: "draft_only",
    qualityChannel: "ai.deliver.design",
  },
];

// ───────────────────────────────────────────────
// Deliverable draft — the AI-generated work
// ───────────────────────────────────────────────

export const DeliverableDraft = z.object({
  content: z.string().max(100_000),  // the actual work (code, copy, design spec)
  // Structured sections (for the UI to render + the freelancer to edit).
  sections: z.array(z.object({
    title: z.string().max(200),
    body: z.string().max(50_000),
    editable: z.boolean(),  // false for generated boilerplate the freelancer can't change
  })).max(20),
  // The AI's self-assessment of completeness (not the truth).
  completenessEstimate: z.number().min(0).max(1),
  // What the AI thinks needs human attention.
  needsHumanReview: z.array(z.string()),
  // Estimated time to complete (the AI's guess at how much human work remains).
  estimatedRemainingMinutes: z.number().int().min(0),
});
export type DeliverableDraft = z.infer<typeof DeliverableDraft>;

// ───────────────────────────────────────────────
// Input — what the AI reads to generate the deliverable
// ───────────────────────────────────────────────

export const DeliveryInput = z.object({
  wsId: z.string().uuid(),
  contractId: z.string().uuid(),
  milestoneId: z.string().uuid(),
  discipline: Discipline,
  // The milestone spec (what the deliverable should contain).
  milestoneTitle: z.string(),
  milestoneDescription: z.string(),
  // The original job brief (for context).
  jobBrief: z.string(),
  // The freelancer's style/tech preferences.
  styleGuide: z.string().optional(),
  techStack: z.array(z.string()).optional(),
  brandGuidelines: z.string().optional(),
  targetAudience: z.string().optional(),
  designReferences: z.array(z.string()).optional(),
});
export type DeliveryInput = z.infer<typeof DeliveryInput>;

// ───────────────────────────────────────────────
// runDelivery — generate a deliverable draft
// ───────────────────────────────────────────────

/**
 * Generate a deliverable draft for a milestone.
 *
 * The verb is discipline-specific: writing_draft for writers,
 * code_scaffold for developers, copy_draft for marketers,
 * design_brief for designers. Each uses a different prompt
 * version + model.
 *
 * The draft is NEVER auto-submitted as a milestone deliverable.
 * The freelancer reviews + edits + commits via the sprint-2
 * submitMilestone function. The edit distance on the actual
 * deliverable is the strongest quality signal.
 */
export async function runDelivery(
  input: DeliveryInput,
  llm: LlmClient,
  drafts: DraftStore,
): Promise<{ draftId: DraftId; deliverable: DeliverableDraft }> {
  // Select the verb by discipline.
  const verbId = input.discipline === "writing"
    ? "deliver.writing_draft"
    : input.discipline === "development"
      ? "deliver.code_scaffold"
      : input.discipline === "marketing"
        ? "deliver.copy_draft"
        : input.discipline === "design"
          ? "deliver.design_brief"
          : "deliver.writing_draft"; // fallback

  const verb = DELIVERY_VERBS.find((v) => v.id === verbId);
  if (!verb) throw new Error(`unknown delivery verb: ${verbId}`);

  const rawOutput = await llm.complete(verb.modelId, verb.promptVersion, {
    discipline: input.discipline,
    milestoneTitle: input.milestoneTitle,
    milestoneDescription: input.milestoneDescription,
    jobBrief: input.jobBrief,
    styleGuide: input.styleGuide,
    techStack: input.techStack,
    brandGuidelines: input.brandGuidelines,
    targetAudience: input.targetAudience,
    designReferences: input.designReferences,
  });

  let deliverable: DeliverableDraft;
  try {
    deliverable = DeliverableDraft.parse(JSON.parse(rawOutput));
  } catch {
    // Fallback: treat raw output as a single section.
    deliverable = DeliverableDraft.parse({
      content: rawOutput.slice(0, 100_000),
      sections: [{
        title: "Draft",
        body: rawOutput.slice(0, 50_000),
        editable: true,
      }],
      completenessEstimate: 0,
      needsHumanReview: ["AI output failed to parse — full human review needed"],
      estimatedRemainingMinutes: 120,
    });
  }

  const provenance = buildProvenance(verb);
  const draft = await drafts.insert({
    wsId: input.wsId,
    verbId: verb.id,
    inputRefs: verb.reads,
    output: JSON.stringify(deliverable),
    provenance,
    generatedAt: new Date().toISOString(),
  });

  await db.transaction(async (tx) => {
    await recordActivity(tx, {
      wsId: input.wsId,
      kind: "supa.ai.delivery.draft",
      ref: {
        verbId: verb.id,
        draftId: draft.id,
        contractId: input.contractId,
        milestoneId: input.milestoneId,
        discipline: input.discipline,
        completeness: deliverable.completenessEstimate,
        sections: deliverable.sections.length,
        needsHumanReview: deliverable.needsHumanReview.length,
      },
    });
  });

  return { draftId: draft.id, deliverable };
}

// ───────────────────────────────────────────────
// Delivery quality — the strongest quality signal
// ───────────────────────────────────────────────

export interface DeliveryQualitySignal {
  verbId: string;
  discipline: string;
  // Edit distance on the actual deliverable (not just a message).
  editDistance: number;
  // Milestone outcome: approved vs changes_requested vs rejected.
  milestoneOutcome: "approved" | "changes_requested" | "pending";
  // The AI's completeness estimate vs actual time to complete.
  estimatedMinutes: number;
  actualMinutes: number | null;
  // How many of the AI's "needsHumanReview" items were actually addressed.
  reviewItemsFlagged: number;
  reviewItemsAddressed: number;
}

/**
 * Build the delivery quality signal. This is the strongest signal
 * in the system: the edit distance on the ACTUAL DELIVERABLE (not
 * a message or a proposal) + the milestone outcome.
 *
 * If the AI's code/copy is lightly edited AND the milestone is
 * approved on first submission, the verb is working perfectly.
 * If it's heavily rewritten or gets "changes_requested", the verb
 * is failing — and the quality loop catches it.
 */
export function buildDeliveryQualitySignal(
  verbId: string,
  discipline: string,
  editDistance: number,
  milestoneOutcome: DeliveryQualitySignal["milestoneOutcome"],
  estimatedMinutes: number,
  actualMinutes: number | null,
  reviewItemsFlagged: number,
  reviewItemsAddressed: number,
): DeliveryQualitySignal {
  return {
    verbId,
    discipline,
    editDistance: Math.round(editDistance * 1000) / 1000,
    milestoneOutcome,
    estimatedMinutes,
    actualMinutes,
    reviewItemsFlagged,
    reviewItemsAddressed,
  };
}
