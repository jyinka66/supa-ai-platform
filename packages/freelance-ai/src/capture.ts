/**
 * @supa/freelance-ai/capture
 * ----------------------------------------------------------------
 * Capture engines — document, email, and voice → structured job draft.
 *
 * Each capture verb:
 *   1. Reads unstructured input (doc text, email thread, voice transcript)
 *   2. Extracts structured fields (title, brief, discipline, skills, budget, deadline)
 *   3. Returns a DRAFT (never auto-published — the human confirms)
 *   4. Records provenance: which model, which prompt version, what input refs
 *
 * The capture pipeline is the autonomous entry point: a freelancer
 * forwards an email or uploads a doc, the AI extracts the job
 * structure, the human reviews + edits + commits. Zero manual
 * data entry for the common case.
 * ----------------------------------------------------------------
 */

import { z } from "zod";
import { db } from "@supa/db";
import { activityFacts } from "@supa/db/schema";
import {
  Verb,
  buildProvenance,
  type DraftStore,
  type LlmClient,
  type DraftId,
} from "./verbs.js";
import { Discipline, Money } from "@supa/freelance-core/job";

// FIX: inlined helper.
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
// Captured job draft — the structured output
// ───────────────────────────────────────────────

export const CapturedJobDraft = z.object({
  title: z.string().min(1).max(200),
  brief: z.string().max(50_000),
  discipline: Discipline,
  skills: z.array(z.string().max(50)).max(30),
  budget: z.object({ value: Money, type: z.enum(["hourly", "fixed"]) }),
  deadline: z.string().datetime().nullable(),
  // Confidence per field — the UI highlights low-confidence fields.
  confidence: z.object({
    title: z.number().min(0).max(1),
    brief: z.number().min(0).max(1),
    discipline: z.number().min(0).max(1),
    skills: z.number().min(0).max(1),
    budget: z.number().min(0).max(1),
    deadline: z.number().min(0).max(1),
  }),
  // Source metadata for the capture.
  sourceType: z.enum(["doc", "email", "voice"]),
  sourceRef: z.string(),  // doc id, email thread id, or voice transcript id
});
export type CapturedJobDraft = z.infer<typeof CapturedJobDraft>;

// ───────────────────────────────────────────────
// Capture verbs — registered in the verb registry
// ───────────────────────────────────────────────

export const CAPTURE_VERBS: readonly Verb[] = [
  {
    id: "capture.from_doc",
    reads: ["doc"],
    modelId: "gemini-1.5-flash",
    promptVersion: "capture.doc.v1",
    writes: "draft_only",
    qualityChannel: "ai.capture.from_doc",
  },
  {
    id: "capture.from_email",
    reads: ["email_thread"],
    modelId: "gemini-1.5-flash",
    promptVersion: "capture.email.v1",
    writes: "draft_only",
    qualityChannel: "ai.capture.from_email",
  },
  {
    id: "capture.from_voice",
    reads: ["voice_transcript"],
    modelId: "gemini-1.5-flash",
    promptVersion: "capture.voice.v1",
    writes: "draft_only",
    qualityChannel: "ai.capture.from_voice",
  },
];

// ───────────────────────────────────────────────
// Capture runner — the autonomous entry point
// ───────────────────────────────────────────────

export interface CaptureInput {
  wsId: string;
  sourceType: "doc" | "email" | "voice";
  sourceRef: string;        // doc id, email thread id, voice transcript id
  content: string;          // the raw text to extract from
}

/**
 * Run a capture verb: extract structured job data from unstructured input.
 *
 * The AI proposes; the human confirms. The capture never auto-creates
 * a job — it returns a draft that the freelancer reviews + edits +
 * commits. Same rule as every verb: writes = "draft_only".
 *
 * For autonomous production: the capture pipeline can be triggered
 * by an email forward, a doc upload, or a voice note. The AI does
 * the extraction; the human does the confirmation. The autonomous
 * loop is: capture → draft → human review → commit → job created.
 */
export async function runCapture(
  input: CaptureInput,
  llm: LlmClient,
  drafts: DraftStore,
): Promise<{ draftId: DraftId; captured: CapturedJobDraft }> {
  const verbId = input.sourceType === "doc"
    ? "capture.from_doc"
    : input.sourceType === "email"
      ? "capture.from_email"
      : "capture.from_voice";

  // Find the verb.
  const verb = CAPTURE_VERBS.find((v) => v.id === verbId);
  if (!verb) throw new Error(`unknown capture verb: ${verbId}`);

  // Run the LLM with the capture prompt.
  const rawOutput = await llm.complete(verb.modelId, verb.promptVersion, {
    content: input.content,
    sourceType: input.sourceType,
  });

  // Parse the LLM output as a captured job draft.
  // The AI is instructed to output JSON matching CapturedJobDraft.
  let captured: CapturedJobDraft;
  try {
    const parsed = z.record(z.string(), z.unknown()).parse(JSON.parse(rawOutput));
    captured = CapturedJobDraft.parse({
      ...parsed,
      sourceType: input.sourceType,
      sourceRef: input.sourceRef,
    });
  } catch {
    // If the LLM output doesn't parse, we still store the raw output
    // as a draft — the human can manually extract from the raw text.
    captured = CapturedJobDraft.parse({
      title: "Untitled (AI capture failed to parse)",
      brief: rawOutput.slice(0, 50_000),
      discipline: "writing",
      skills: [],
      budget: { value: { amountMinor: 0, currency: "NGN" }, type: "fixed" },
      deadline: null,
      confidence: {
        title: 0, brief: 0, discipline: 0, skills: 0, budget: 0, deadline: 0,
      },
      sourceType: input.sourceType,
      sourceRef: input.sourceRef,
    });
  }

  // Store as a draft with full provenance.
  const provenance = buildProvenance(verb);
  const draft = await drafts.insert({
    wsId: input.wsId,
    verbId: verb.id,
    inputRefs: verb.reads,
    output: JSON.stringify(captured),
    provenance,
    generatedAt: new Date().toISOString(),
  });

  await db.transaction(async (tx) => {
    await recordActivity(tx, {
      wsId: input.wsId,
      kind: "supa.ai.capture.run",
      ref: {
        verbId: verb.id,
        draftId: draft.id,
        sourceType: input.sourceType,
        sourceRef: input.sourceRef,
        discipline: captured.discipline,
        avgConfidence: Object.values(captured.confidence).reduce((a, b) => a + b, 0) / 6,
      },
    });
  });

  return { draftId: draft.id, captured };
}

// ───────────────────────────────────────────────
// Batch capture — autonomous inbox processing
// ───────────────────────────────────────────────

/**
 * Process multiple capture inputs in a batch (e.g. the autonomous
 * inbox: a freelancer forwards 5 emails, each becomes a draft).
 *
 * Each capture runs independently — one failure doesn't block
 * the others. Returns per-input results (success or error).
 */
export async function runBatchCapture(
  inputs: readonly CaptureInput[],
  llm: LlmClient,
  drafts: DraftStore,
): Promise<PromiseSettledResult<{ draftId: DraftId; captured: CapturedJobDraft }>[]> {
  return Promise.allSettled(
    inputs.map((input) => runCapture(input, llm, drafts)),
  );
}

// ───────────────────────────────────────────────
// Capture quality — the per-field confidence signal
// ───────────────────────────────────────────────

export interface CaptureQualitySignal {
  verbId: string;
  sourceType: "doc" | "email" | "voice";
  avgConfidence: number;
  lowConfidenceFields: string[];  // fields below 0.7 threshold
  parseSucceeded: boolean;
}

export function computeCaptureQuality(captured: CapturedJobDraft): CaptureQualitySignal {
  const fields = Object.entries(captured.confidence);
  const avgConfidence = fields.reduce((sum, [, v]) => sum + v, 0) / fields.length;
  const lowConfidenceFields = fields
    .filter(([, v]) => v < 0.7)
    .map(([k]) => k);
  const parseSucceeded = captured.title !== "Untitled (AI capture failed to parse)";

  return {
    verbId: `capture.from_${captured.sourceType}`,
    sourceType: captured.sourceType,
    avgConfidence: Math.round(avgConfidence * 1000) / 1000,
    lowConfidenceFields,
    parseSucceeded,
  };
}
