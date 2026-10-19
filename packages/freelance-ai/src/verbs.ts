// Verbs are registered, not scattered. Each declares: what it
// reads, what it writes, where its output lands, and its
// quality measurement hook. If a verb isn't registered, it
// doesn't ship — "rogue summarize" (a surface nobody planned
// measuring) is exactly how unmeasurable AI accrues.

import { z } from "zod";
import { db } from "@supa/db";
import { activityFacts } from "@supa/db/schema";

// FIX: inlined helper (same pattern as all files).
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
// Verb schema — the registered AI surface declaration
// ───────────────────────────────────────────────

export const Verb = z.object({
  id: z.string(),                          // e.g. "proposal.draft"
  reads: z.array(z.string()),              // fact/doc refs — provenance for what the model saw
  modelId: z.string(),
  promptVersion: z.string(),
  writes: z.enum(["draft_only"]),          // INVARIANT: every verb writes drafts. No verb
                                           // mutates a fact, a listing, a contract, or money.
  qualityChannel: z.string(),              // metric key in the ai-quality channel
});

export type Verb = z.infer<typeof Verb>;

// FIX: Verb has no provenance() method (it's a Zod object, not a class).
// Added a standalone function that builds provenance from the verb's fields.
export interface VerbProvenance {
  verbId: string;
  modelId: string;
  promptVersion: string;
  inputRefs: string[];
  qualityChannel: string;
}

export function buildProvenance(verb: Verb): VerbProvenance {
  return {
    verbId: verb.id,
    modelId: verb.modelId,
    promptVersion: verb.promptVersion,
    inputRefs: [...verb.reads],
    qualityChannel: verb.qualityChannel,
  };
}

// ───────────────────────────────────────────────
// The launch verbs
// ───────────────────────────────────────────────
//
//   capture.from_doc      — document → structured supa-source job draft
//   capture.from_email    — email thread → job draft (E2EE'd input per sprint 0 rule)
//   capture.from_voice    — voice note transcript → job draft
//   brief.summarize       — long brief → structured summary (shown alongside, never replacing, the original)
//   proposal.draft        — listing + profile facts → cover letter draft
//   milestone.suggest     — contract draft → proposed milestone split (integer-sum checked before display)
//
// Note milestone.suggest: it proposes, the sum-to-total rule
// (sprint 2) rejects impossible splits at submit time. The AI
// can be wrong about arithmetic; the machine cannot.

export const LAUNCH_VERBS: readonly Verb[] = [
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
  {
    id: "brief.summarize",
    reads: ["job_brief"],
    modelId: "gemini-1.5-flash",
    promptVersion: "brief.summarize.v1",
    writes: "draft_only",
    qualityChannel: "ai.brief.summarize",
  },
  {
    id: "proposal.draft",
    reads: ["listing", "freelancer_profile"],
    modelId: "gemini-1.5-flash",
    promptVersion: "proposal.draft.v1",
    writes: "draft_only",
    qualityChannel: "ai.proposal.draft",
  },
  {
    id: "milestone.suggest",
    reads: ["contract_draft"],
    modelId: "gemini-1.5-flash",
    promptVersion: "milestone.suggest.v1",
    writes: "draft_only",
    qualityChannel: "ai.milestone.suggest",
  },
];

// ───────────────────────────────────────────────
// Verb registry — registered, not scattered
// ───────────────────────────────────────────────

export class VerbRegistry {
  private readonly verbs = new Map<string, Verb>();

  register(verb: Verb): void {
    Verb.parse(verb);
    if (this.verbs.has(verb.id)) {
      throw new Error(`verb already registered: ${verb.id}`);
    }
    this.verbs.set(verb.id, verb);
  }

  get(verbId: string): Verb {
    const verb = this.verbs.get(verbId);
    if (!verb) {
      throw new Error(`verb not registered: ${verbId} — "rogue summarize" is exactly how unmeasurable AI accrues`);
    }
    return verb;
  }

  list(): readonly Verb[] {
    return [...this.verbs.values()];
  }
}

// The singleton registry, pre-loaded with the launch verbs.
export const registry = new VerbRegistry();
for (const verb of LAUNCH_VERBS) {
  registry.register(verb);
}

// ───────────────────────────────────────────────
// LLM client interface
// ───────────────────────────────────────────────

// FIX: llm was undefined. Added the interface.
export interface LlmClient {
  complete(modelId: string, promptVersion: string, input: Record<string, unknown>): Promise<string>;
}

// ───────────────────────────────────────────────
// Draft lifecycle — uniform for every verb
// ───────────────────────────────────────────────
//
//   generated → edited → used | discarded
//
// "edited" is measured: the delta between draft and what the
// human actually sent is the single most honest quality signal
// that exists. A verb whose outputs are always heavily edited
// is failing, whatever its benchmark scores say.

export const DraftStatus = z.enum(["generated", "edited", "used", "discarded"]);
export type DraftStatus = z.infer<typeof DraftStatus>;

export const Draft = z.object({
  id: z.string().uuid(),
  wsId: z.string().uuid(),
  verbId: z.string(),
  inputRefs: z.array(z.string()),
  output: z.string(),                       // the AI-generated draft text
  provenance: z.object({
    verbId: z.string(),
    modelId: z.string(),
    promptVersion: z.string(),
    inputRefs: z.array(z.string()),
    qualityChannel: z.string(),
  }),
  status: DraftStatus,
  // FIX: added editedOutput — the human's final text (null until edited).
  editedOutput: z.string().nullable(),
  // FIX: added timestamps.
  generatedAt: z.string().datetime(),
  editedAt: z.string().datetime().nullable(),
  committedAt: z.string().datetime().nullable(),
});
export type Draft = z.infer<typeof Draft>;

// FIX: DraftId was used but never defined.
export type DraftId = string;

/**
 * Outcome of a draft that produced a downstream decision (currently
 * only `proposal.draft` produces outcomes — hired / rejected by the
 * client on supa-board). The quality loop accepts an optional map of
 * draftId → outcome so win rate can be computed without joining the
 * drafts table to the supa-board applications table at query time.
 *
 * `null` (or the absence of an entry) means "no outcome yet" — the
 * proposal is still pending, withdrawn, or wasn't tracked.
 */
export type DraftOutcome = "hired" | "rejected";

// ───────────────────────────────────────────────
// Commit target — where the edited draft lands
// ───────────────────────────────────────────────

// FIX: CommitTarget was used but never defined.
export const CommitTarget = z.enum([
  "application_cover_letter",
  "listing_summary",
  "job_brief_summary",
  "milestone_proposal",
  "job_draft",
]);
export type CommitTarget = z.infer<typeof CommitTarget>;

// ───────────────────────────────────────────────
// Draft store interface
// ───────────────────────────────────────────────

// FIX: drafts was undefined. Added the interface + in-memory impl.
export interface DraftStore {
  insert(draft: Omit<Draft, "id" | "status" | "editedOutput" | "editedAt" | "committedAt">): Promise<Draft>;
  findById(wsId: string, draftId: string): Promise<Draft | null>;
  update(wsId: string, draftId: string, changes: Partial<Pick<Draft, "status" | "editedOutput" | "editedAt" | "committedAt">>): Promise<Draft>;
}

export class InMemoryDraftStore implements DraftStore {
  private readonly drafts = new Map<string, Draft>();

  insert(input: Omit<Draft, "id" | "status" | "editedOutput" | "editedAt" | "committedAt">): Promise<Draft> {
    const draft: Draft = Draft.parse({
      ...input,
      id: crypto.randomUUID(),
      status: "generated",
      editedOutput: null,
      editedAt: null,
      committedAt: null,
    });
    this.drafts.set(draft.id, draft);
    return Promise.resolve(draft);
  }

  findById(wsId: string, draftId: string): Promise<Draft | null> {
    const draft = this.drafts.get(draftId);
    if (!draft || draft.wsId !== wsId) return Promise.resolve(null);
    return Promise.resolve(draft);
  }

  update(wsId: string, draftId: string, changes: Partial<Pick<Draft, "status" | "editedOutput" | "editedAt" | "committedAt">>): Promise<Draft> {
    const draft = this.drafts.get(draftId);
    if (!draft || draft.wsId !== wsId) throw new Error(`draft ${draftId} not found`);
    const updated = Draft.parse({ ...draft, ...changes });
    this.drafts.set(draftId, updated);
    return Promise.resolve(updated);
  }
}

// ───────────────────────────────────────────────
// Quality signal — the edit-distance metric
// ───────────────────────────────────────────────

export interface DraftQualitySignal {
  verbId: string;
  modelId: string;
  promptVersion: string;
  qualityChannel: string;
  draftLength: number;
  editedLength: number;
  editDistance: number;        // 0 = identical, 1 = completely rewritten
  timeToCommitMs: number;
  discarded: boolean;
}

/**
 * Compute the quality signal for a committed/discard draft.
 * The edit distance (0..1) is the single most honest quality signal:
 * a verb whose outputs are always heavily edited is failing, whatever
 * its benchmark scores say.
 *
 * Uses a simple character-level similarity ratio (real impl uses
 * Levenshtein; this is the contract for the quality channel).
 */
export function computeQualitySignal(draft: Draft, now: string = new Date().toISOString()): DraftQualitySignal {
  const draftText = draft.output;
  const editedText = draft.editedOutput ?? draft.output;
  const draftLength = draftText.length;
  const editedLength = editedText.length;

  // Simple similarity ratio (real impl: Levenshtein distance / max length).
  const maxLength = Math.max(draftLength, editedLength);
  const editDistance = maxLength === 0 ? 0 : 1 - simpleSimilarity(draftText, editedText);

  const committedAt = draft.committedAt ?? now;
  const timeToCommitMs = new Date(committedAt).getTime() - new Date(draft.generatedAt).getTime();

  return {
    verbId: draft.provenance.verbId,
    modelId: draft.provenance.modelId,
    promptVersion: draft.provenance.promptVersion,
    qualityChannel: draft.provenance.qualityChannel,
    draftLength,
    editedLength,
    editDistance: Math.round(editDistance * 1000) / 1000,
    timeToCommitMs,
    discarded: draft.status === "discarded",
  };
}

function simpleSimilarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  const maxLen = Math.max(a.length, b.length);
  let matches = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) matches++;
  }
  return matches / maxLen;
}

// ───────────────────────────────────────────────
// runVerb — generate a draft with full provenance
// ───────────────────────────────────────────────

// FIX: llm + drafts were undefined. Now parameters with defaults.
export async function runVerb(
  wsId: string,
  verbId: string,
  input: Record<string, unknown>,
  llm: LlmClient,
  drafts: DraftStore = new InMemoryDraftStore(),
): Promise<DraftId> {
  const verb = registry.get(verbId);
  const drafted = await llm.complete(verb.modelId, verb.promptVersion, input);
  // FIX: verb.provenance() was a method call on a Zod object — replaced
  // with the standalone buildProvenance() function.
  const provenance = buildProvenance(verb);
  // Draft stored with full provenance: verb, model, prompt
  // version, input refs, latency. Never auto-published — the
  // sprint 2 rule (aiSummary freezes at publish; humans author)
  // is enforced here at the source: verbs CAN'T write to
  // published surfaces, by the `writes: "draft_only"` type.
  const draft = await drafts.insert({
    wsId,
    verbId: verb.id,
    inputRefs: verb.reads,
    output: drafted,
    provenance,
    generatedAt: new Date().toISOString(),
  });

  await db.transaction(async (tx) => {
    await recordActivity(tx, {
      wsId,
      kind: "supa.ai.verb.run",
      ref: { verbId: verb.id, draftId: draft.id, modelId: verb.modelId, promptVersion: verb.promptVersion },
    });
  });

  return draft.id;
}

// ───────────────────────────────────────────────
// commitDraft — the human's final text lands on the target
// ───────────────────────────────────────────────

export async function commitDraft(
  wsId: string,
  draftId: string,
  editedOutput: string,
  target: CommitTarget,
  drafts: DraftStore = new InMemoryDraftStore(),
): Promise<{ draft: Draft; qualitySignal: DraftQualitySignal }> {
  const draft = await drafts.findById(wsId, draftId);
  if (!draft) {
    throw new Error(`draft ${draftId} not found in workspace ${wsId}`);
  }

  const now = new Date().toISOString();
  const updated = await drafts.update(wsId, draftId, {
    status: "used",
    editedOutput,
    editedAt: now,
    committedAt: now,
  });

  // Record: similarity(draft, edited) → ai-quality channel
  //   editDistance, timeToCommit, discarded flag
  // Win-rate-per-(model,prompt) version for proposals joins
  // this with the hire/reject facts from supa-board — closed
  // loop, queryable, no extra logging of content.
  // FIX: "nova-board" → "supa-board".
  const qualitySignal = computeQualitySignal(updated, now);

  await db.transaction(async (tx) => {
    await recordActivity(tx, {
      wsId,
      kind: "supa.ai.draft.committed",
      ref: {
        draftId,
        verbId: draft.verbId,
        target,
        editDistance: qualitySignal.editDistance,
        timeToCommitMs: qualitySignal.timeToCommitMs,
      },
    });
  });

  return { draft: updated, qualitySignal };
}

// ───────────────────────────────────────────────
// discardDraft — the human rejected the AI output entirely
// ───────────────────────────────────────────────

export async function discardDraft(
  wsId: string,
  draftId: string,
  drafts: DraftStore = new InMemoryDraftStore(),
): Promise<{ draft: Draft; qualitySignal: DraftQualitySignal }> {
  const draft = await drafts.findById(wsId, draftId);
  if (!draft) {
    throw new Error(`draft ${draftId} not found in workspace ${wsId}`);
  }

  const now = new Date().toISOString();
  const updated = await drafts.update(wsId, draftId, {
    status: "discarded",
    committedAt: now,
  });

  // Discard is the strongest quality signal: the human threw it away entirely.
  // editDistance = 1 (completely rewritten / replaced).
  const qualitySignal: DraftQualitySignal = {
    verbId: draft.provenance.verbId,
    modelId: draft.provenance.modelId,
    promptVersion: draft.provenance.promptVersion,
    qualityChannel: draft.provenance.qualityChannel,
    draftLength: draft.output.length,
    editedLength: 0,
    editDistance: 1,  // fully discarded
    timeToCommitMs: new Date(now).getTime() - new Date(draft.generatedAt).getTime(),
    discarded: true,
  };

  await db.transaction(async (tx) => {
    await recordActivity(tx, {
      wsId,
      kind: "supa.ai.draft.discarded",
      ref: { draftId, verbId: draft.verbId },
    });
  });

  return { draft: updated, qualitySignal };
}
