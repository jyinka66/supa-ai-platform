/**
 * @supa/freelance-ai/comms
 * ----------------------------------------------------------------
 * Client communication verb — the biggest time sink for freelancers.
 * AI-drafted client messages: progress updates, clarification
 * requests, delivery notifications. Same draft→edit→commit lifecycle.
 *
 * Quality signal: did the freelancer edit it? Did the client
 * respond? Did it resolve the thread? The natural feedback loop
 * for communication quality.
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
// Communication verbs
// ───────────────────────────────────────────────

export const COMMS_VERBS: readonly Verb[] = [
  {
    id: "comms.progress_update",
    reads: ["contract", "milestone", "activity_facts"],
    modelId: "gemini-1.5-flash",
    promptVersion: "comms.progress.v1",
    writes: "draft_only",
    qualityChannel: "ai.comms.progress_update",
  },
  {
    id: "comms.clarification_request",
    reads: ["contract", "milestone", "message_thread"],
    modelId: "gemini-1.5-flash",
    promptVersion: "comms.clarification.v1",
    writes: "draft_only",
    qualityChannel: "ai.comms.clarification_request",
  },
  {
    id: "comms.delivery_notification",
    reads: ["contract", "milestone", "submission"],
    modelId: "gemini-1.5-flash",
    promptVersion: "comms.delivery.v1",
    writes: "draft_only",
    qualityChannel: "ai.comms.delivery_notification",
  },
  {
    id: "comms.follow_up",
    reads: ["message_thread", "activity_facts"],
    modelId: "gemini-1.5-flash",
    promptVersion: "comms.followup.v1",
    writes: "draft_only",
    qualityChannel: "ai.comms.follow_up",
  },
];

// ───────────────────────────────────────────────
// Message draft — the AI output
// ───────────────────────────────────────────────

export const MessageDraft = z.object({
  body: z.string().max(5_000),
  subject: z.string().max(200).optional(), // optional for thread replies
  tone: z.enum(["professional", "friendly", "urgent"]),
  // What the AI referenced (for provenance + quality measurement).
  referencedFacts: z.array(z.string()),
  // The AI's confidence that it captured the right context.
  confidence: z.number().min(0).max(1),
});
export type MessageDraft = z.infer<typeof MessageDraft>;

// ───────────────────────────────────────────────
// Input — what the AI reads to draft the message
// ───────────────────────────────────────────────

export const CommsInput = z.object({
  wsId: z.string().uuid(),
  contractId: z.string().uuid(),
  milestoneId: z.string().uuid().optional(),
  // The verb to run.
  verbId: z.enum(["comms.progress_update", "comms.clarification_request", "comms.delivery_notification", "comms.follow_up"]),
  // Context the AI reads.
  contractTitle: z.string(),
  milestoneTitle: z.string().optional(),
  milestoneStatus: z.string().optional(),
  // Recent message thread (for context + tone matching).
  recentMessages: z.array(z.object({
    sender: z.enum(["freelancer", "client"]),
    body: z.string(),
    at: z.string().datetime(),
  })).max(20),
  // Recent activity facts on the contract (for progress updates).
  recentActivity: z.array(z.object({
    kind: z.string(),
    at: z.string().datetime(),
  })).max(20),
});
export type CommsInput = z.infer<typeof CommsInput>;

// ───────────────────────────────────────────────
// runComms — draft a client message
// ───────────────────────────────────────────────

export async function runComms(
  input: CommsInput,
  llm: LlmClient,
  drafts: DraftStore,
): Promise<{ draftId: DraftId; message: MessageDraft }> {
  const verb = COMMS_VERBS.find((v) => v.id === input.verbId);
  if (!verb) throw new Error(`unknown comms verb: ${input.verbId}`);

  const rawOutput = await llm.complete(verb.modelId, verb.promptVersion, {
    verbId: input.verbId,
    contractTitle: input.contractTitle,
    milestoneTitle: input.milestoneTitle,
    milestoneStatus: input.milestoneStatus,
    recentMessages: input.recentMessages,
    recentActivity: input.recentActivity,
  });

  let message: MessageDraft;
  try {
    message = MessageDraft.parse(JSON.parse(rawOutput));
  } catch {
    message = MessageDraft.parse({
      body: rawOutput.slice(0, 5_000),
      tone: "professional",
      referencedFacts: [],
      confidence: 0,
    });
  }

  const provenance = buildProvenance(verb);
  const draft = await drafts.insert({
    wsId: input.wsId,
    verbId: verb.id,
    inputRefs: verb.reads,
    output: JSON.stringify(message),
    provenance,
    generatedAt: new Date().toISOString(),
  });

  await db.transaction(async (tx) => {
    await recordActivity(tx, {
      wsId: input.wsId,
      kind: "supa.ai.comms.draft",
      ref: {
        verbId: verb.id,
        draftId: draft.id,
        contractId: input.contractId,
        tone: message.tone,
        confidence: message.confidence,
      },
    });
  });

  return { draftId: draft.id, message };
}

// ───────────────────────────────────────────────
// Communication quality — the natural feedback loop
// ───────────────────────────────────────────────

export interface CommsQualitySignal {
  verbId: string;
  editDistance: number;
  // Did the client respond? (the strongest signal for comms quality).
  clientResponded: boolean;
  // Did the thread resolve (no more messages needed)?
  threadResolved: boolean;
  // Time from message sent to client response (ms). Null = no response.
  responseTimeMs: number | null;
}

/**
 * Build the comms quality signal. The natural feedback loop:
 *   - Edit distance: did the freelancer rewrite the AI's draft?
 *   - Client responded: did the message get a reply?
 *   - Thread resolved: did the exchange close the loop?
 *   - Response time: how long did the client take to reply?
 *
 * A comms verb whose drafts are never edited AND always get a
 * response is working perfectly — the AI is drafting messages the
 * freelancer sends as-is and the client engages with.
 */
export function buildCommsQualitySignal(
  verbId: string,
  editDistance: number,
  clientResponded: boolean,
  threadResolved: boolean,
  sentAt: number,
  firstResponseAt: number | null,
): CommsQualitySignal {
  return {
    verbId,
    editDistance: Math.round(editDistance * 1000) / 1000,
    clientResponded,
    threadResolved,
    responseTimeMs: firstResponseAt !== null ? firstResponseAt - sentAt : null,
  };
}
