/**
 * @supa/freelance-ai/agent
 * ----------------------------------------------------------------
 * Autonomous agent loop — the global production autonomous work
 * orchestrator. Chains verbs into workflows:
 *
 *   1. Capture (email/doc/voice → job draft)
 *   2. Brief summarize (long brief → structured summary)
 *   3. Proposal draft (listing + profile → cover letter)
 *   4. Milestone suggest (contract → milestone split)
 *
 * Each step produces a DRAFT; the human confirms between steps.
 * The agent never auto-commits — it chains drafts, not facts.
 * The human is always in the loop; the agent is a productivity
 * multiplier, not an autonomous actor.
 *
 * The quality loop closes: every draft's edit distance feeds the
 * ai-quality channel. Per-(model, prompt) win rates are queryable.
 * ----------------------------------------------------------------
 */

import { z } from "zod";
import { db } from "@supa/db";
import { activityFacts } from "@supa/db/schema";
import type { DraftStore, LlmClient, DraftId, Draft, DraftOutcome } from "./verbs.js";
import { runCapture, type CaptureInput } from "./capture.js";
import { runProposal, type ProposalInput, type ProposalDraft } from "./proposal.js";
import { runMilestoneSuggest, type MilestoneSuggestInput, type MilestoneSuggestion } from "./milestones.js";
import { runBriefSummarize, type BriefSummary } from "./brief.js";

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
// Agent workflow — the chain of verbs
// ───────────────────────────────────────────────

export type WorkflowStep =
  | "capture"
  | "brief_summarize"
  | "proposal_draft"
  | "milestone_suggest";

export type WorkflowStatus = "pending" | "running" | "awaiting_human" | "completed" | "failed";

export interface WorkflowState {
  readonly wsId: string;
  readonly workflowId: string;
  readonly steps: readonly {
    step: WorkflowStep;
    status: WorkflowStatus;
    draftId: DraftId | null;
    startedAt: number | null;
    completedAt: number | null;
    error: string | null;
  }[];
  readonly currentStep: number;
  readonly status: WorkflowStatus;
}

// ───────────────────────────────────────────────
// Agent — chains verbs into workflows
// ───────────────────────────────────────────────

export interface AgentConfig {
  /** Whether to auto-advance after capture (skip human review of the job draft). */
  autoAdvanceAfterCapture: boolean;
  /** Whether to auto-advance after brief summarize. */
  autoAdvanceAfterBrief: boolean;
  /** Max concurrent workflows per workspace. */
  maxConcurrentWorkflows: number;
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  autoAdvanceAfterCapture: false,
  autoAdvanceAfterBrief: false,
  maxConcurrentWorkflows: 3,
};

export class AutonomousAgent {
  constructor(
    private readonly llm: LlmClient,
    private readonly drafts: DraftStore,
    private readonly config: AgentConfig = DEFAULT_AGENT_CONFIG,
  ) {}

  /**
   * Run the capture → brief → proposal workflow.
   *
   * The agent chains verbs: capture produces a job draft, brief
   * summarize produces a structured summary, proposal draft produces
   * a cover letter. Each step pauses for human review unless
   * autoAdvance is set.
   *
   * The agent NEVER auto-commits — it produces drafts, not facts.
   */
  async runCaptureToProposal(
    wsId: string,
    captureInput: CaptureInput,
  ): Promise<{
    workflowId: string;
    state: WorkflowState;
    captureResult: { draftId: DraftId; captured: import("./capture.js").CapturedJobDraft } | null;
    briefResult: { draftId: DraftId; summary: BriefSummary } | null;
    proposalResult: { draftId: DraftId; proposal: ProposalDraft } | null;
  }> {
    const workflowId = crypto.randomUUID();
    const now = Date.now();

    const steps: WorkflowState["steps"] = [
      { step: "capture", status: "pending", draftId: null, startedAt: null, completedAt: null, error: null },
      { step: "brief_summarize", status: "pending", draftId: null, startedAt: null, completedAt: null, error: null },
      { step: "proposal_draft", status: "pending", draftId: null, startedAt: null, completedAt: null, error: null },
    ];

    let captureResult: { draftId: DraftId; captured: import("./capture.js").CapturedJobDraft } | null = null;
    let briefResult: { draftId: DraftId; summary: BriefSummary } | null = null;
    let proposalResult: { draftId: DraftId; proposal: ProposalDraft } | null = null;

    // Step 1: Capture.
    steps[0]!.status = "running";
    steps[0]!.startedAt = now;
    try {
      captureResult = await runCapture(captureInput, this.llm, this.drafts);
      steps[0]!.status = "completed";
      steps[0]!.draftId = captureResult.draftId;
      steps[0]!.completedAt = Date.now();
    } catch (err) {
      steps[0]!.status = "failed";
      steps[0]!.error = err instanceof Error ? err.message : String(err);
      return { workflowId, state: this.buildState(wsId, workflowId, steps, 0, "failed"), captureResult: null, briefResult: null, proposalResult: null };
    }

    // Pause for human review unless autoAdvance.
    if (!this.config.autoAdvanceAfterCapture) {
      return {
        workflowId,
        state: this.buildState(wsId, workflowId, steps, 1, "awaiting_human"),
        captureResult,
        briefResult: null,
        proposalResult: null,
      };
    }

    // Step 2: Brief summarize (uses the captured brief).
    steps[1]!.status = "running";
    steps[1]!.startedAt = Date.now();
    try {
      briefResult = await runBriefSummarize(wsId, captureResult.captured.brief, this.llm, this.drafts);
      steps[1]!.status = "completed";
      steps[1]!.draftId = briefResult.draftId;
      steps[1]!.completedAt = Date.now();
    } catch (err) {
      steps[1]!.status = "failed";
      steps[1]!.error = err instanceof Error ? err.message : String(err);
      return { workflowId, state: this.buildState(wsId, workflowId, steps, 1, "failed"), captureResult, briefResult: null, proposalResult: null };
    }

    if (!this.config.autoAdvanceAfterBrief) {
      return {
        workflowId,
        state: this.buildState(wsId, workflowId, steps, 2, "awaiting_human"),
        captureResult,
        briefResult,
        proposalResult: null,
      };
    }

    // Step 3: Proposal draft (uses the captured job + brief summary).
    steps[2]!.status = "running";
    steps[2]!.startedAt = Date.now();
    try {
      // Build proposal input from capture + brief results.
      const proposalInput: ProposalInput = {
        listing: {
          title: captureResult.captured.title,
          brief: captureResult.captured.brief,
          discipline: captureResult.captured.discipline,
          skills: captureResult.captured.skills,
          budget: captureResult.captured.budget,
        },
        freelancerProfile: {
          headline: "",
          bio: "",
          skills: [],
          completedContracts: 0,
          byDiscipline: [],
        },
        proposedRate: captureResult.captured.budget,
        proposedDays: 30,
      };
      proposalResult = await runProposal(wsId, proposalInput, this.llm, this.drafts);
      steps[2]!.status = "completed";
      steps[2]!.draftId = proposalResult.draftId;
      steps[2]!.completedAt = Date.now();
    } catch (err) {
      steps[2]!.status = "failed";
      steps[2]!.error = err instanceof Error ? err.message : String(err);
      return { workflowId, state: this.buildState(wsId, workflowId, steps, 2, "failed"), captureResult, briefResult, proposalResult: null };
    }

    return {
      workflowId,
      state: this.buildState(wsId, workflowId, steps, 3, "completed"),
      captureResult,
      briefResult,
      proposalResult,
    };
  }

  /**
   * Run the milestone suggest workflow (standalone — after a contract draft exists).
   */
  async runMilestoneWorkflow(
    wsId: string,
    input: MilestoneSuggestInput,
  ): Promise<{
    workflowId: string;
    state: WorkflowState;
    milestoneResult: { draftId: DraftId; suggestion: MilestoneSuggestion } | null;
  }> {
    const workflowId = crypto.randomUUID();
    const steps: WorkflowState["steps"] = [
      { step: "milestone_suggest", status: "running", draftId: null, startedAt: Date.now(), completedAt: null, error: null },
    ];

    try {
      const result = await runMilestoneSuggest(wsId, input, this.llm, this.drafts);
      steps[0]!.status = "completed";
      steps[0]!.draftId = result.draftId;
      steps[0]!.completedAt = Date.now();

      await db.transaction(async (tx) => {
        await recordActivity(tx, {
          wsId,
          kind: "supa.ai.agent.milestone_workflow_completed",
          ref: { workflowId, draftId: result.draftId, sumMatches: result.suggestion.sumMatches },
        });
      });

      return {
        workflowId,
        state: this.buildState(wsId, workflowId, steps, 1, "completed"),
        milestoneResult: result,
      };
    } catch (err) {
      steps[0]!.status = "failed";
      steps[0]!.error = err instanceof Error ? err.message : String(err);
      return {
        workflowId,
        state: this.buildState(wsId, workflowId, steps, 0, "failed"),
        milestoneResult: null,
      };
    }
  }

  private buildState(
    wsId: string,
    workflowId: string,
    steps: WorkflowState["steps"],
    currentStep: number,
    status: WorkflowStatus,
  ): WorkflowState {
    return { wsId, workflowId, steps, currentStep, status };
  }
}

// ───────────────────────────────────────────────
// Quality loop — per-verb, per-(model,prompt) win rates
// ───────────────────────────────────────────────

export interface VerbQualitySummary {
  verbId: string;
  modelId: string;
  promptVersion: string;
  totalDrafts: number;
  committedCount: number;
  discardedCount: number;
  avgEditDistance: number;
  // For proposal.draft: win rate (hired / submitted).
  winRate: number | null;
}

/**
 * Compute the quality summary for a verb across all its drafts.
 * This is the closed loop: the AI proposes, the human edits/commits/
 * discards, and the quality signal feeds back into the model/prompt
 * version selection. A verb whose outputs are always heavily edited
 * is failing, whatever its benchmark scores say.
 *
 * `outcomes` is an optional Map<draftId, DraftOutcome> (hire/reject)
 * that closes the win-rate loop for `proposal.draft`. When omitted,
 * `winRate` is null — the same as before this fix — so existing
 * callers keep working. When provided, win rate is
 * hired / (hired + rejected) across the verb's drafts.
 */
export function computeVerbQualitySummary(
  drafts: readonly Draft[],
  verbId: string,
  outcomes?: ReadonlyMap<string, DraftOutcome>,
): VerbQualitySummary | null {
  const verbDrafts = drafts.filter((d) => d.provenance.verbId === verbId);
  if (verbDrafts.length === 0) return null;

  const committed = verbDrafts.filter((d) => d.status === "used");
  const discarded = verbDrafts.filter((d) => d.status === "discarded");

  // Compute average edit distance for committed drafts.
  const editDistances = committed.map((d) => {
    const draftLen = d.output.length;
    const editedLen = (d.editedOutput ?? d.output).length;
    const maxLen = Math.max(draftLen, editedLen);
    if (maxLen === 0) return 0;
    // Simple similarity (real impl: Levenshtein).
    let matches = 0;
    for (let i = 0; i < Math.min(draftLen, editedLen); i++) {
      if (d.output[i] === d.editedOutput![i]) matches++;
    }
    return 1 - matches / maxLen;
  });
  const avgEditDistance = editDistances.length > 0
    ? editDistances.reduce((a, b) => a + b, 0) / editDistances.length
    : 0;

  // Win rate only applies to proposal.draft (joined with hire/reject
  // facts from supa-board). When outcomes are provided, win rate is
  // hired / (hired + rejected) — drafts without an outcome are
  // treated as still pending and excluded from the denominator.
  let winRate: number | null = null;
  if (verbId === "proposal.draft" && outcomes && outcomes.size > 0) {
    let hired = 0;
    let resolved = 0;
    for (const d of verbDrafts) {
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
    modelId: verbDrafts[0]!.provenance.modelId,
    promptVersion: verbDrafts[0]!.provenance.promptVersion,
    totalDrafts: verbDrafts.length,
    committedCount: committed.length,
    discardedCount: discarded.length,
    avgEditDistance: Math.round(avgEditDistance * 1000) / 1000,
    winRate,
  };
}
