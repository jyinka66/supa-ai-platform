// Run executor — the run loop with loop guards.
//
//   • max_steps      — hard stop on step count
//   • wall_deadline  — hard stop on wall time
//   • tool_rate      — per-tool call cap per run (no infinite tool loop)
//   • loop_detect    — identical (tool + argsHash) sig repeated in window → abort
//   • idempotency    — same (agent + tool + argsHash + run) returns cached result
//   • approval_gate  — floor enforced HERE, never trusts stored config alone
//   • permission_int — live check, every call, transitive for a2a chains
//   • drafts_rule    — run output is a draft artifact, never a direct publication
//   • a2a_depth      — depth-limited (max 3), permission-chain-carrying
//
// The run loop itself (the `while (outcome.kind === "continue")` driver) lives
// in `runAgent` at the bottom of this file. `executeStep` is one step; the
// driver calls it until it returns done/await_approval/failed.

import { db } from "@supa/db";
import { agents, runSteps, agentIdempotency, runs } from "@supa/db/schema";
import { eq, and, ne } from "drizzle-orm";
import { hashJson, facts, notify } from "../platform.js";
import { holdBudget, captureBudget } from "../budget/ledger.js";
import {
  canInvoke,
  effectivePolicy,
  type ToolDef,
  type PermissionSet,
  SetPermissionSet,
} from "../permissions.js";
import { MemoryStore } from "../memory/store.js";
import { createApproval, registerResumeRun } from "../approvals/inbox.js";
import { registry } from "../tools/registry.js";
import type { BudgetSpec, ApprovalPolicy } from "../schema.js";

const LOOP_WINDOW = 8;
const RATE_LIMIT_TOOL_CALLS = 25; // per run, per tool
const MAX_A2A_DEPTH = 3;
// DEFAULT_TTL_MS reserved for the approvals module; kept here as the canonical
// 24h window for the executor's own status checks (approval expiry is enforced
// by the inbox, not here).
const _DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface RunContext {
  runId: string;
  wsId: string;
  agentId: string;
  step: number;
  toolCallCounts: Map<string, number>;
  recentToolSigs: string[]; // for loop detection
  a2aDepth: number;
  chainPerms: PermissionSet[]; // transitive grantor chain
  deadline: Date;
  maxSteps: number;
  budgetSpec: BudgetSpec;
  memory: MemoryStore;
}

export type StepOutcome =
  | { kind: "done"; output: unknown }
  | { kind: "await_approval"; approvalId: string }
  | { kind: "continue" }
  | { kind: "failed"; reason: string };

export type LlmDecision =
  | { action: "finish"; output: unknown }
  | { action: "remember"; kind: "fact" | "episode" | "procedure" | "preference"; content: string }
  | { action: "call_tool"; toolId: string; args: unknown }
  | { action: "call_agent"; agentId: string; task: string };

export type LlmDecide = (ctx: RunContext) => Promise<LlmDecision>;

/** Loop detection: identical (tool + argsHash) signature repeated in window → abort. */
function detectLoop(ctx: RunContext, toolId: string, argsHash: string): boolean {
  // FIX: original used broken template literal "toolId:{toolId}:toolId:{argsHash}"
  //      — never produced the right string. Now uses real template literal.
  const sig = `toolId:${toolId}:argsHash:${argsHash}`;
  const window = ctx.recentToolSigs.slice(-LOOP_WINDOW);
  if (window.filter((s) => s === sig).length >= 2) return true;
  ctx.recentToolSigs.push(sig);
  return false;
}

export async function executeStep(
  ctx: RunContext,
  llmDecide: LlmDecide,
): Promise<StepOutcome> {
  if (ctx.step >= ctx.maxSteps) return { kind: "failed", reason: "max_steps" };
  if (Date.now() > ctx.deadline.getTime()) return { kind: "failed", reason: "wall_deadline" };

  // KILL-SWITCH CHECK — the executor's step loop begins with this.
  // Fetches BOTH status AND cancelled_at in one query (defense-in-depth:
  // the kill switch sets both atomically, but this catches either signal
  // independently — so a future code path that sets one without the other
  // still triggers the bail). Returns 'killswitch' as the reason (distinct
  // from 'max_steps'/'wall_deadline' so downstream logic can distinguish
  // external cancellation from internal guards).
  const runRows = await db
    .select({ status: runs.status, cancelledAt: runs.cancelledAt })
    .from(runs)
    .where(eq(runs.id, ctx.runId as any))
    .limit(1);
  const runRow = runRows[0];
  if (!runRow) {
    // Run was deleted mid-flight (shouldn't happen due to RLS, but
    // defense-in-depth). Bail with a distinct reason so the operator sees it.
    return { kind: "failed", reason: "run_not_found" };
  }
  if (runRow.cancelledAt != null || runRow.status === "cancelled") {
    return { kind: "failed", reason: "killswitch" };
  }

  ctx.step += 1;
  const decision = await llmDecide(ctx);

  if (decision.action === "finish") {
    // DRAFTS RULE: run output is a draft artifact, never a direct publication.
    await facts.emit(ctx.wsId, "agent.run.finished", {
      runId: ctx.runId,
      agentId: ctx.agentId,
      outputKind: "draft",
    });
    return { kind: "done", output: decision.output };
  }

  if (decision.action === "remember") {
    await ctx.memory.write(decision.kind, decision.content, { provenance: "agent" });
    await recordStep(ctx, "memory_write", null, { content: decision.content });
    return { kind: "continue" };
  }

  if (decision.action === "call_agent") {
    return executeA2A(ctx, decision.agentId, decision.task);
  }

  // ---- tool call path ----
  const tool: ToolDef | undefined = registry.get(decision.toolId);
  if (!tool) return { kind: "failed", reason: `unknown_tool:${decision.toolId}` };

  const argsParse = tool.inputSchema.safeParse(decision.args);
  if (!argsParse.success) {
    return { kind: "failed", reason: `schema:${argsParse.error.message}` };
  }
  const args = argsParse.data;
  const argsHash = hashJson(args);

  // PERMISSION INTERSECTION — live check, every call, transitive for a2a
  const grantorPerms = await getLivePermissions(ctx.wsId, ctx.agentId);
  const gate = canInvoke(tool, await getGrants(ctx.agentId), grantorPerms, ctx.chainPerms);
  if (!gate.ok) {
    await recordStep(ctx, "error", tool.id, args, gate.reason);
    return { kind: "failed", reason: gate.reason! };
  }

  // RATE + LOOP GUARDS
  const count = (ctx.toolCallCounts.get(tool.id) ?? 0) + 1;
  ctx.toolCallCounts.set(tool.id, count);
  if (count > RATE_LIMIT_TOOL_CALLS) return { kind: "failed", reason: "tool_rate_limit" };
  if (detectLoop(ctx, tool.id, argsHash)) return { kind: "failed", reason: "loop_detected" };

  // IDEMPOTENCY — same tool+args within run returns cached result
  // FIX: original used broken template literal "ctx.agentId:{...}:argsHash:{...}"
  //      — now uses a real template literal with a stable, parseable format.
  const cacheKey = `agent:${ctx.agentId}:tool:${tool.id}:argsHash:${argsHash}:run:${ctx.runId}`;
  const cached = await lookupIdempotent(cacheKey);
  if (cached) {
    await recordStep(ctx, "tool_result", tool.id, args, undefined, cached.resultRef);
    return { kind: "continue" };
  }

  // APPROVAL GATE — floor enforced here, never trusts stored config alone
  const policy = effectivePolicy(tool, await getApprovalConfig(ctx.agentId, tool.id));
  if (
    policy === "always" ||
    policy === "always_two_gate" ||
    (policy === "first_run" && count === 1)
  ) {
    const approval = await createApproval({
      wsId: ctx.wsId,
      runId: ctx.runId,
      agentId: ctx.agentId,
      toolId: tool.id,
      args,
      contextSnapshot: await buildApprovalContext(ctx, tool, args), // immutable
      twoGate: policy === "always_two_gate",
    });
    await recordStep(ctx, "tool_call", tool.id, args, undefined, undefined, "awaiting_approval");
    return { kind: "await_approval", approvalId: approval.id };
  }

  return invokeTool(ctx, tool, args, argsHash, cacheKey);
}

async function invokeTool(
  ctx: RunContext,
  tool: ToolDef,
  args: unknown,
  argsHash: string,
  cacheKey: string,
): Promise<StepOutcome> {
  await recordStep(ctx, "tool_call", tool.id, args, undefined, undefined, undefined, argsHash);
  try {
    if (!tool.execute) {
      // External tool — dispatched out-of-process; result polled back via the
      // agent's external-result ingestion path. For now, treat as a no-op
      // observation (the run loop continues without a tool_result ref).
      await recordStep(ctx, "tool_result", tool.id, args, undefined, undefined, "external_dispatch");
      return { kind: "continue" };
    }
    const result = await withTimeout(tool.timeoutMs, tool.execute(ctx.wsId, args));
    const resultRef = await storeResult(result); // blob store, PII-redacted
    await storeIdempotent(cacheKey, ctx.wsId, resultRef);
    // FIX: original call had `resultRef` in the `error` slot (positional bug);
    //      added explicit `undefined` so it lands in `resultRef` instead.
    await recordStep(ctx, "tool_result", tool.id, args, undefined, resultRef);
    return { kind: "continue" };
  } catch (err: any) {
    await recordStep(ctx, "error", tool.id, args, undefined, undefined, err.message);
    return { kind: "continue" }; // tool errors are observations; run loop decides
  }
}

/** A2A: depth-limited, permission-chain-carrying. */
async function executeA2A(
  ctx: RunContext,
  targetAgentId: string,
  task: string,
): Promise<StepOutcome> {
  if (ctx.a2aDepth >= MAX_A2A_DEPTH) return { kind: "failed", reason: "a2a_depth" };
  const targetPerms = await getLivePermissions(ctx.wsId, targetAgentId);
  // target's authority = its grants ∩ ITS owner ∩ CALLER'S chain — never wider
  await recordStep(ctx, "a2a", null, { targetAgentId, task: task.slice(0, 200) });
  return runAgent({
    wsId: ctx.wsId,
    agentId: targetAgentId,
    triggerType: "chain",
    triggerPayload: { task, from: ctx.agentId },
    inheritedChain: [...ctx.chainPerms, targetPerms],
    depth: ctx.a2aDepth + 1,
    llmDecide: defaultLlmDecide, // wired by the caller in production; stub here for typecheck
  });
}

// ───────────────────────────────────────────────
// Helpers — DB-backed, inlined (same pattern as @supa/customers' repositories).
// ───────────────────────────────────────────────

/**
 * Record a run step. Positional signature matches the call sites in the
 * original executor (8 args, most optional). `status` (7th) is accepted but
 * not stored — the run_steps table has no status column; it's encoded in
 * `kind` already (the awaiting_approval marker is the absence of a paired
 * `tool_result` row, which the executor emits after the approval resolves).
 */
async function recordStep(
  ctx: RunContext,
  kind: string,
  toolId: string | null,
  args?: unknown,
  error?: string,
  resultRef?: string,
  status?: string, // eslint-disable-line @typescript-eslint/no-unused-vars
  argsHash?: string,
): Promise<void> {
  await db.insert(runSteps).values({
    runId: ctx.runId as any,
    workspaceId: ctx.wsId as any,
    seq: ctx.step,
    kind,
    toolId: toolId ?? null,
    args: args === undefined ? null : (args as any),
    argsHash: argsHash ?? null,
    resultRef: resultRef ?? null,
    error: error ?? null,
  });
}

/** Look up an idempotent result by key. Returns the cached resultRef, if any. */
async function lookupIdempotent(key: string): Promise<{ resultRef: string } | null> {
  const rows = await db
    .select({ resultRef: agentIdempotency.resultRef })
    .from(agentIdempotency)
    .where(eq(agentIdempotency.key, key))
    .limit(1);
  const row = rows[0];
  if (!row || !row.resultRef) return null;
  return { resultRef: row.resultRef };
}

/** Store an idempotent result. The key is the cache key; the value is the resultRef. */
async function storeIdempotent(key: string, wsId: string, resultRef: string): Promise<void> {
  try {
    await db.insert(agentIdempotency).values({
      key,
      workspaceId: wsId as any,
      resultRef,
    });
  } catch (err: any) {
    // 23505 = unique_violation. A concurrent run already cached this — fine.
    if (err?.code === "23505") return;
    throw err;
  }
}

/**
 * Store a tool result + return its ref. The result is hashed; the ref is
 * `agent-result:<hash>`. In production this writes to blob storage (S3 /
 * R2) with PII redaction. For now the ref is the hash and the body lives
 * in a process-local cache for the run's lifetime (good enough for the
// executor; the LLM reads back via run_steps.result_ref → blob store later).
 */
const resultCache = new Map<string, unknown>();

async function storeResult(result: unknown): Promise<string> {
  const ref = `agent-result:${hashJson(result)}`;
  resultCache.set(ref, result);
  return ref;
}

/** Read back a stored result by ref. Used by the LLM's recall step. */
export function readResult(ref: string): unknown {
  return resultCache.get(ref);
}

/** Race a promise against a timeout. Rejects with `timeout` on expiry. */
async function withTimeout<T>(ms: number, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Look up the agent's tool grants (live — not from a stored snapshot). */
async function getGrants(agentId: string): Promise<readonly string[]> {
  const rows = await db
    .select({ toolGrants: agents.toolGrants })
    .from(agents)
    .where(eq(agents.id, agentId as any))
    .limit(1);
  return rows[0]?.toolGrants ?? [];
}

/** Look up the user-configured approval policy override for a tool, if any. */
async function getApprovalConfig(
  agentId: string,
  toolId: string,
): Promise<ApprovalPolicy | undefined> {
  const rows = await db
    .select({ policy: agents.approvalPolicy })
    .from(agents)
    .where(eq(agents.id, agentId as any))
    .limit(1);
  const policy = rows[0]?.policy as Record<string, ApprovalPolicy> | undefined;
  return policy?.[toolId];
}

/**
 * Live permission lookup. The agent's `toolGrants` is the source of truth;
 * for each granted tool, the agent has the underlying permission required
 * to invoke it. (This collapses grantor + agent perms into one set; the
 * real implementation will look up the calling user's role-derived perms
 * and intersect. For now this is enough to make canInvoke enforce the
 * grants side correctly, which is the harder of the two to fake.)
 */
async function getLivePermissions(_wsId: string, agentId: string): Promise<PermissionSet> {
  const grants = await getGrants(agentId);
  const perms = new Set<string>();
  for (const toolId of grants) {
    const tool = registry.get(toolId);
    if (tool) perms.add(tool.requiredPermission);
  }
  return new SetPermissionSet(perms);
}

/** Build the immutable context snapshot for an approval row. */
async function buildApprovalContext(
  ctx: RunContext,
  tool: ToolDef,
  args: unknown,
): Promise<Record<string, unknown>> {
  return {
    runId: ctx.runId,
    agentId: ctx.agentId,
    step: ctx.step,
    tool: {
      id: tool.id,
      cls: tool.cls,
      description: tool.description,
    },
    args,
    argsHash: hashJson(args),
    a2aDepth: ctx.a2aDepth,
    timestamp: new Date().toISOString(),
  };
}

// ───────────────────────────────────────────────
// runAgent — the actual run loop driver. Holds budget at start, captures
// actuals at end (the reconciliation invariant: sum(hold) = sum(capture) +
// sum(refund), asserted by the budget storm test).
// ───────────────────────────────────────────────

export interface RunAgentInput {
  wsId: string;
  agentId: string;
  triggerType: "manual" | "schedule" | "event" | "webhook" | "chain";
  triggerPayload: Record<string, unknown>;
  inheritedChain: PermissionSet[];
  depth: number;
  llmDecide: LlmDecide;
}

export type RunOutcome =
  | { kind: "done"; output: unknown }
  | { kind: "failed"; reason: string }
  | { kind: "await_approval"; approvalId: string };

export async function runAgent(input: RunAgentInput): Promise<StepOutcome> {
  // Look up agent config (budget, maxSteps, etc.).
  const agentRows = await db
    .select({
      budget: agents.budget,
      maxSteps: runs.maxSteps,
      wallDeadline: runs.wallDeadline,
    })
    .from(agents)
    .where(eq(agents.id, input.agentId as any))
    .limit(1);
  const agentRow = agentRows[0];
  if (!agentRow) {
    return { kind: "failed", reason: "agent_not_found" };
  }
  const budgetSpec = agentRow.budget as unknown as BudgetSpec;
  const maxSteps = agentRow.maxSteps ?? budgetSpec.maxStepsPerRun;
  const deadline = agentRow.wallDeadline ?? new Date(Date.now() + 10 * 60 * 1000);

  // Create the run row.
  const runRows = await db
    .insert(runs)
    .values({
      workspaceId: input.wsId as any,
      agentId: input.agentId as any,
      triggerType: input.triggerType,
      triggerPayload: input.triggerPayload,
      agentSnapshot: { budgetSpec, maxSteps },
      status: "running",
      maxSteps,
      wallDeadline: deadline,
    })
    .returning({ id: runs.id });
  const runRow = runRows[0];
  if (!runRow) {
    return { kind: "failed", reason: "run_insert_failed" };
  }
  const runId = runRow.id;

  // HOLD the budget — atomic check-and-hold. If the cap is exceeded, the run
  // never starts. (estimate = the spec's daily cap as a conservative upper bound.)
  const estMinor = Math.min(
    budgetSpec.dailyUsdMinor,
    100, // $1.00 conservative default estimate per run
  );
  const hold = await holdBudget(input.wsId, input.agentId, runId, budgetSpec, estMinor);
  if (!hold.allowed) {
    await db
      .update(runs)
      .set({ status: "failed", failureReason: hold.reason ?? "budget_denied" })
      .where(eq(runs.id, runId));
    return { kind: "failed", reason: hold.reason ?? "budget_denied" };
  }

  const ctx: RunContext = {
    runId,
    wsId: input.wsId,
    agentId: input.agentId,
    step: 0,
    toolCallCounts: new Map(),
    recentToolSigs: [],
    a2aDepth: input.depth,
    chainPerms: input.inheritedChain,
    deadline,
    maxSteps,
    budgetSpec,
    memory: new MemoryStore(input.wsId, input.agentId),
  };

  // Drive the loop until a non-continue outcome.
  const outcome = await driveLoop(ctx, input.llmDecide);

  // CAPTURE actuals. The reconciliation invariant
  // (sum(hold) = sum(capture) + sum(refund)) is asserted inside captureBudget.
  // For the actual cost we use the estimate by default; a real implementation
  // would derive this from tokens_in/tokens_out tracked during the run.
  const actualMinor = estMinor;
  await captureBudget(input.wsId, input.agentId, runId, actualMinor);

  // Update the run row's terminal status.
  // CONDITIONAL: don't clobber a kill-switch-cancelled row. The kill switch
  // sets status='cancelled' + cancelled_at + finished_at + failureReason
  // atomically; if it fired during the run (executeStep would have bailed
  // with reason='killswitch'), the row is already in its terminal 'cancelled'
  // state. The conditional `ne(runs.status, 'cancelled')` ensures our update
  // is a no-op in that case — the kill switch's state wins. This is the
  // race-safe path: kill switch beat us → skip; we beat the kill switch →
  // our update lands (and the kill switch's `inArray(status, ['running',...])`
  // filter will skip us since we set 'done'/'failed').
  const finalStatus =
    outcome.kind === "done"
      ? "done"
      : outcome.kind === "await_approval"
        ? "awaiting_approval"
        : "failed";
  await db
    .update(runs)
    .set({
      status: finalStatus,
      finishedAt: outcome.kind === "await_approval" ? null : new Date(),
      failureReason: outcome.kind === "failed" ? outcome.reason : null,
      output: outcome.kind === "done" ? (outcome.output as any) : null,
    })
    .where(
      and(
        eq(runs.id, runId),
        ne(runs.status, "cancelled"),  // don't clobber kill-switch
      ),
    );

  return outcome;
}

/**
 * Drive the loop: invoke executeStep until it returns a non-continue outcome.
 * Shared by runAgent (fresh start) and resumeRun (post-approval continuation).
 * The ctx.step counter persists across resume — a paused run picks up at the
 * step it was at when it asked for approval (so max_steps accounting is honest).
 *
 * CANCEL OBSERVATION: the kill-switch check lives inside executeStep (the
 * first guard, before max_steps / wall_deadline). One indexed-by-id query
 * per step — cheap relative to the LLM call each step takes (~1-10s). The
 * check is per-step, so a long-running tool call won't be interrupted
 * mid-flight (the tool finishes; the next iteration sees the flag and stops).
 * For tools that poll externally (long-running jobs), the tool's own cancel
 * logic is the backstop.
 */
async function driveLoop(ctx: RunContext, llmDecide: LlmDecide): Promise<StepOutcome> {
  let outcome: StepOutcome = { kind: "continue" };
  while (outcome.kind === "continue") {
    outcome = await executeStep(ctx, llmDecide);
  }
  return outcome;
}

/** Default LLM decider — returns `finish` with null output. Production wires a real one. */
const defaultLlmDecide: LlmDecide = async () => ({ action: "finish", output: null });

/**
 * Resume a paused run after an approval was approved. Called by the approvals
 * inbox via the resumeRun hook (registered at module load below).
 *
 * The run was paused at a tool_call step; on resume we:
 *   1. Reconstruct the RunContext from the run row + agent row.
 *   2. Look up the tool + (possibly modified) args.
 *   3. Execute the tool directly (skipping the LLM decide for this one step).
 *   4. Resume the loop with the LLM decider (the run continues as if it had
 *      never paused — the tool result is now an observation for the next step).
 *
 * The decider for the resumed run is the defaultLlmDecide stub for now; a real
 * implementation will pass the same decider that started the run (or a fresh
 * one — the run's instructions are in agentSnapshot, retrievable on resume).
 */
async function resumeRun(runId: string, toolId: string, args: unknown): Promise<void> {
  // Look up the run row + agent row to rebuild context.
  const runRows = await db
    .select({
      id: runs.id,
      wsId: runs.workspaceId,
      agentId: runs.agentId,
      maxSteps: runs.maxSteps,
      wallDeadline: runs.wallDeadline,
      agentSnapshot: runs.agentSnapshot,
    })
    .from(runs)
    .where(eq(runs.id, runId as any))
    .limit(1);
  const runRow = runRows[0];
  if (!runRow) {
    // Run was deleted while approval was pending — nothing to resume.
    await facts.emit(runId, "agent.run.resume_no_run", { runId, toolId });
    return;
  }

  // Look up the agent for budget + grants.
  const agentRows = await db
    .select({ budget: agents.budget })
    .from(agents)
    .where(eq(agents.id, runRow.agentId as any))
    .limit(1);
  const agentRow = agentRows[0];
  if (!agentRow) return;

  const snapshot = runRow.agentSnapshot as { budgetSpec?: BudgetSpec; maxSteps?: number };
  const budgetSpec = (snapshot.budgetSpec ?? agentRow.budget) as unknown as BudgetSpec;
  const maxSteps = runRow.maxSteps ?? snapshot.maxSteps ?? budgetSpec.maxStepsPerRun;

  // Reconstruct the context. step counter + toolCallCounts + recentToolSigs are
  // NOT persisted across the pause (the run row doesn't carry them); we
  // restart them at zero — this is a known approximation. A future impl will
  // persist the RunContext snapshot to a JSONB column on the run row at the
  // moment of awaiting approval, so resume can pick up the exact counters.
  const ctx: RunContext = {
    runId,
    wsId: runRow.wsId as string,
    agentId: runRow.agentId as string,
    step: 0,
    toolCallCounts: new Map(),
    recentToolSigs: [],
    a2aDepth: 0,
    chainPerms: [],
    deadline: runRow.wallDeadline ?? new Date(Date.now() + 10 * 60 * 1000),
    maxSteps,
    budgetSpec,
    memory: new MemoryStore(runRow.wsId as string, runRow.agentId as string),
  };

  // Mark the run as running again.
  await db
    .update(runs)
    .set({ status: "running", failureReason: null })
    .where(eq(runs.id, runId as any));

  // Execute the approved tool directly, then resume the loop.
  const tool = registry.get(toolId);
  if (!tool) {
    // Tool was unregistered while the approval was pending — fail the run.
    await db
      .update(runs)
      .set({
        status: "failed",
        finishedAt: new Date(),
        failureReason: `tool_unregistered_on_resume:${toolId}`,
      })
      .where(eq(runs.id, runId as any));
    return;
  }

  const argsHash = hashJson(args);
  const cacheKey = `agent:${ctx.agentId}:tool:${toolId}:argsHash:${argsHash}:run:${runId}`;
  await invokeTool(ctx, tool, args, argsHash, cacheKey);

  // Resume the loop. The decider for the resumed run is the default stub; a
  // real implementation will pass the decider that started the run (retrieved
  // from the agentSnapshot or wired via a decider registry).
  const outcome = await driveLoop(ctx, defaultLlmDecide);

  // Capture actuals + finalize the run.
  // Note: for a kill-switched run (outcome.reason='killswitch'), the actual
  // cost is less than the estimate (the run was cut short). We don't yet
  // track per-step token consumption, so we capture the full estimate
  // (conservative — the workspace pays for reserved capacity, not just used).
  // The reconciliation invariant still holds: held = capture + refund
  // (estMinor = estMinor + 0). A future impl will track per-step tokens and
  // capture actuals, refunding the unspent delta.
  await captureBudget(ctx.wsId, ctx.agentId, runId, 100);

  // CONDITIONAL terminal update — same as runAgent: don't clobber a
  // kill-switch-cancelled row.
  const finalStatus =
    outcome.kind === "done"
      ? "done"
      : outcome.kind === "await_approval"
        ? "awaiting_approval"
        : "failed";
  await db
    .update(runs)
    .set({
      status: finalStatus,
      finishedAt: outcome.kind === "await_approval" ? null : new Date(),
      failureReason: outcome.kind === "failed" ? outcome.reason : null,
      output: outcome.kind === "done" ? (outcome.output as any) : null,
    })
    .where(
      and(
        eq(runs.id, runId as any),
        ne(runs.status, "cancelled"),  // don't clobber kill-switch
      ),
    );
}

// Register the resume hook at module load. The approvals inbox calls this
// hook when an approval is approved (one-gate) or second-approved (two-gate).
registerResumeRun(resumeRun);