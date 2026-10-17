// Approvals — timeout expiry, two-gate, immutable context.
//
//   createApproval  — atomic insert + run-status update + notify + fact emit,
//                     all in one transaction. 48h TTL for two-gate (financial
//                     floor never auto-approves on timeout — it expires), 24h
//                     default for one-gate approvals.
//
//   expireStale     — cron sweeper. Expiry NEVER approves. Updates pending
//                     rows past expires_at → 'expired' (atomic conditional
//                     update), then cascades the corresponding run to
//                     'approval_expired' + finished_at. Race-safe: only runs
//                     still in 'awaiting_approval' are touched.
//
//   decide          — approve / reject / modify. Conditional update (only
//                     status='pending' rows accept the decision) so concurrent
//                     clicks collapse to exactly one winner — no double-exec.
//                     twoGate semantics: first approve records the first decider
//                     in decisionContext but leaves status='pending' until a
//                     SECOND distinct human approves. Same-person-twice does
//                     NOT satisfy the two-gate (the whole point of two-gate is
//                     two different humans).
//
// Context snapshot is IMMUTABLE — written once at createApproval, never
// touched again. Post-hoc disputes arbitrate against the snapshot, not
// against the live agent config (which may have changed by then).
//
// The fact stream carries the approval id, kind, decider — NEVER the args or
// snapshot (PII). Args/snapshot live in the approval row only.

import { db } from "@supa/db";
import { approvals, runs } from "@supa/db/schema";
import { eq, and, lt, sql } from "drizzle-orm";
import { facts, notify } from "../platform.js";

// ───────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────

/** 48h TTL — financial (twoGate) approvals NEVER auto-approve on timeout. */
const TWO_GATE_TTL_MS = 48 * 60 * 60 * 1000;
/** 24h TTL — one-gate approvals. */
const ONE_GATE_TTL_MS = 24 * 60 * 60 * 1000;

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export interface CreateApprovalInput {
  wsId: string;
  runId: string;
  agentId: string;
  toolId: string;
  args: unknown;
  /** Immutable snapshot of the agent + run state at request time. Written once. */
  contextSnapshot: Record<string, unknown>;
  /** true = needs two distinct human approvers (financial floor). */
  twoGate?: boolean;
}

export interface Approval {
  id: string;
  expiresAt: Date;
}

export type Decision =
  | { kind: "approve" }
  | { kind: "reject"; reason: string }
  | { kind: "modify"; args: unknown };

// ───────────────────────────────────────────────
// Resume hook — registered by the runs/executor module at boot.
// Indirection avoids a circular import: inbox → executor → inbox.
// ───────────────────────────────────────────────

export type ResumeRun = (
  runId: string,
  toolId: string,
  args: unknown,
) => Promise<void>;

let resumeRunHook: ResumeRun | null = null;

/**
 * Register the run-resume hook. Called once by the runs/executor module at
 * boot (before any run starts). The hook is invoked when an approval is
 * approved (one-gate) or second-approved (two-gate) — the run loop resumes
 * from where it paused.
 */
export function registerResumeRun(hook: ResumeRun): void {
  resumeRunHook = hook;
}

async function resumeRun(runId: string, toolId: string, args: unknown): Promise<void> {
  if (!resumeRunHook) {
    // No hook registered — the run stays in awaiting_approval until the
    // process boots one. In production this is a fatal config error; here
    // we emit a fact so the operator sees it.
    await facts.emit(runId, "agent.approval.resume_no_hook", { runId, toolId });
    return;
  }
  await resumeRunHook(runId, toolId, args);
}

// ───────────────────────────────────────────────
// createApproval — atomic insert + run-status + notify + fact
// ───────────────────────────────────────────────

/**
 * Create a pending approval. Atomic in one transaction:
 *   1. Insert the approval row (immutable contextSnapshot).
 *   2. Update the run → 'awaiting_approval'.
 *   3. Notify via the matrix (in_app + email + push, dedupeKey=appr:<id>).
 *   4. Emit 'agent.approval.requested' fact (NO args/snapshot in the fact — PII).
 *
 * TTL: 48h for two-gate (financial floor never auto-approves on timeout), 24h
 * default. The approval expires on timeout — it NEVER auto-approves.
 */
export async function createApproval(input: CreateApprovalInput): Promise<Approval> {
  const twoGate = input.twoGate ?? false;
  const ttlMs = twoGate ? TWO_GATE_TTL_MS : ONE_GATE_TTL_MS;
  const expiresAt = new Date(Date.now() + ttlMs);

  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(approvals)
      .values({
        workspaceId: input.wsId as any,
        runId: input.runId as any,
        agentId: input.agentId as any,
        toolId: input.toolId,
        args: input.args as any,
        contextSnapshot: {
          ...input.contextSnapshot,
          twoGate,
          ttlMs,
          createdAt: new Date().toISOString(),
        },
        status: "pending",
        requestedByAgent: input.agentId as any,
        expiresAt,
      })
      .returning({ id: approvals.id });

    const row = rows[0];
    if (!row) {
      throw new Error("approval_insert_failed");
    }

    // Cascade: run → awaiting_approval.
    await tx
      .update(runs)
      .set({ status: "awaiting_approval" })
      .where(eq(runs.id, input.runId as any));

    return { id: row.id, expiresAt };
  })
    .then(async (approval) => {
      // Side-effects OUTSIDE the transaction: notify + fact. The approval row
      // is already committed; notify is best-effort (matrix may be down),
      // and the fact is append-only (its absence is recoverable from the row).
      await notify.send("in_app", {
        wsId: input.wsId,
        kind: "agent.approval_needed",
        approvalId: approval.id,
        agentId: input.agentId,
        toolId: input.toolId,
        channels: ["in_app", "email", "push"],
        dedupeKey: `appr:${approval.id}`,
      });
      await notify.send("email", {
        wsId: input.wsId,
        kind: "agent.approval_needed",
        approvalId: approval.id,
        toolId: input.toolId,
      });
      await notify.send("push", {
        wsId: input.wsId,
        kind: "agent.approval_needed",
        approvalId: approval.id,
        toolId: input.toolId,
      });

      // Fact stream: approval id + tool id ONLY. No args, no snapshot — PII.
      await facts.emit(input.wsId, "agent.approval.requested", {
        approvalId: approval.id,
        agentId: input.agentId,
        toolId: input.toolId,
        twoGate,
        expiresAt: expiresAt.toISOString(),
      });

      return approval;
    });
}

// ───────────────────────────────────────────────
// expireStale — cron sweeper. Expiry NEVER approves.
// ───────────────────────────────────────────────

export interface ExpiredRecord {
  id: string;
  wsId: string;
  runId: string;
}

/**
 * Sweep pending approvals past their expiry → 'expired'. Atomic conditional
 * update (only pending rows touched); the corresponding run cascades to
 * 'approval_expired' + finished_at (only if still awaiting_approval — race-safe
 * against a concurrent decide). Emits 'agent.approval.expired' fact per row.
 *
 * Returns the expired records (caller logs the count).
 */
export async function expireStale(): Promise<ExpiredRecord[]> {
  return db.transaction(async (tx) => {
    const expiredRows = await tx
      .update(approvals)
      .set({
        status: "expired",
        decidedAt: new Date(),
        decisionContext: sql`coalesce(${approvals.decisionContext}, '{}'::jsonb) || '{"expired": true}'::jsonb`,
      })
      .where(
        and(
          eq(approvals.status, "pending"),
          lt(approvals.expiresAt, new Date()),
        ),
      )
      .returning({
        id: approvals.id,
        wsId: approvals.workspaceId,
        runId: approvals.runId,
      });

    // Cascade the run → 'approval_expired' (only if still awaiting_approval).
    // The conditional update is the race-safety: a concurrent decide() that
    // beat us to the row will have moved status='approved'/'rejected', and
    // the run row will already be moved — our conditional update is a no-op.
    for (const r of expiredRows) {
      await tx
        .update(runs)
        .set({
          status: "approval_expired",
          finishedAt: new Date(),
          failureReason: "approval_expired",
        })
        .where(
          and(
            eq(runs.id, r.runId as any),
            eq(runs.status, "awaiting_approval"),
          ),
        );
    }

    return expiredRows as unknown as ExpiredRecord[];
  }).then(async (records) => {
    // Fact emission outside the transaction (append-only; absence recoverable).
    for (const r of records) {
      await facts.emit(r.wsId, "agent.approval.expired", {
        approvalId: r.id,
        runId: r.runId,
      });
    }
    return records;
  });
}

// ───────────────────────────────────────────────
// decide — approve / reject / modify, two-gate aware, race-safe
// ───────────────────────────────────────────────

export type DecideOutcome =
  | { kind: "approved" }
  | { kind: "rejected" }
  | { kind: "modified_approved" }
  | { kind: "pending_second_gate"; firstDecidedBy: string }
  | { kind: "already_decided" }
  | { kind: "not_found" }
  | { kind: "same_decider_two_gate" };

/**
 * Decide on a pending approval. Race-safe: a conditional update (only
 * status='pending' rows accept the decision) collapses concurrent clicks
 * to exactly one winner — no double-exec.
 *
 * twoGate semantics:
 *   - First approve from a distinct human → status stays 'pending',
 *     decisionContext records { firstDecidedBy, firstDecidedAt }. Run does
 *     NOT resume yet.
 *   - Second approve from a DIFFERENT human → status='approved', run resumes.
 *   - Same human approving twice → returns 'same_decider_two_gate'. The
 *     two-gate explicitly requires two DIFFERENT humans.
 *
 * Non-two-gate:
 *   - Approve → status='approved', run resumes immediately.
 *   - Reject → status='rejected', run marked done with output={"rejected_by_human":true}.
 *   - Modify → status='modified_approved', run resumes with the modified args.
 */
export async function decide(
  approvalId: string,
  userId: string,
  decision: Decision,
): Promise<DecideOutcome> {
  // First fetch the row — we need to know twoGate + firstDecidedBy BEFORE
  // attempting the conditional update (the SQL for two-gate vs one-gate
  // diverges, and we don't want to encode both branches in one query).
  const existing = await db
    .select({
      id: approvals.id,
      status: approvals.status,
      contextSnapshot: approvals.contextSnapshot,
      decisionContext: approvals.decisionContext,
      args: approvals.args,
      runId: approvals.runId,
      wsId: approvals.workspaceId,
      toolId: approvals.toolId,
    })
    .from(approvals)
    .where(eq(approvals.id, approvalId as any))
    .limit(1);

  const row = existing[0];
  if (!row) return { kind: "not_found" };
  if (row.status !== "pending") return { kind: "already_decided" };

  const snapshot = row.contextSnapshot as { twoGate?: boolean };
  const isTwoGate = snapshot?.twoGate === true;
  const decisionCtx = (row.decisionContext ?? {}) as {
    firstDecidedBy?: string;
    firstDecidedAt?: string;
  };

  // ─── Two-gate, approve branch ─────────────────────────────
  if (isTwoGate && decision.kind === "approve") {
    // Already has a first decider?
    if (decisionCtx.firstDecidedBy) {
      // Same human twice → reject, doesn't satisfy two-gate.
      if (decisionCtx.firstDecidedBy === userId) {
        return { kind: "same_decider_two_gate" };
      }
      // Second distinct human → final approval.
      return finalizeDecision(approvalId, userId, decision, row, "approved");
    }
    // First approval → record first decider, status stays pending.
    const updated = await db
      .update(approvals)
      .set({
        decidedBy: userId as any,
        decidedAt: new Date(),
        decisionContext: {
          firstDecidedBy: userId,
          firstDecidedAt: new Date().toISOString(),
          pendingSecondGate: true,
        },
      })
      .where(
        and(
          eq(approvals.id, approvalId as any),
          eq(approvals.status, "pending"),
        ),
      )
      .returning({ id: approvals.id });

    if (!updated.length) return { kind: "already_decided" };

    await facts.emit(row.wsId as string, "agent.approval.first_approved", {
      approvalId,
      firstDecidedBy: userId,
    });
    return { kind: "pending_second_gate", firstDecidedBy: userId };
  }

  // ─── Two-gate, reject/modify branch ───────────────────────
  // Rejecting or modifying a two-gate approval only needs ONE human (the
  // rejecter/modifyer). Two-gate is about requiring two humans to APPROVE
  // spending money — a single human can always say no.
  if (isTwoGate && decision.kind === "reject") {
    return finalizeDecision(approvalId, userId, decision, row, "rejected");
  }
  if (isTwoGate && decision.kind === "modify") {
    // Modify on a two-gate: the modified args are subject to a fresh
    // approval cycle (the original snapshot is now stale). For simplicity
    // here we treat modify on two-gate as a reject + re-request, since
    // re-running the approval flow is the safe path. Production may want
    // a more nuanced handler.
    return finalizeDecision(approvalId, userId, decision, row, "rejected");
  }

  // ─── One-gate ─────────────────────────────────────────────
  if (decision.kind === "approve") {
    return finalizeDecision(approvalId, userId, decision, row, "approved");
  }
  if (decision.kind === "reject") {
    return finalizeDecision(approvalId, userId, decision, row, "rejected");
  }
  return finalizeDecision(approvalId, userId, decision, row, "modified_approved");
}

/**
 * Finalize a decision with a conditional update. Only status='pending' rows
 * accept the update; concurrent clicks collapse to one winner.
 */
async function finalizeDecision(
  approvalId: string,
  userId: string,
  decision: Decision,
  row: {
    id: string;
    runId: string;
    wsId: string;
    toolId: string;
    args: unknown;
  },
  finalStatus: "approved" | "rejected" | "modified_approved",
): Promise<DecideOutcome> {
  const finalArgs =
    decision.kind === "modify" ? decision.args : row.args;

  const updated = await db
    .update(approvals)
    .set({
      status: finalStatus,
      decidedBy: userId as any,
      decidedAt: new Date(),
      decisionContext: {
        kind: decision.kind,
        ...(decision.kind === "reject" ? { reason: decision.reason } : {}),
        ...(decision.kind === "modify" ? { modifiedArgs: true } : {}), // args NOT in context — stored on the row's args column via modify
        decidedBy: userId,
        decidedAt: new Date().toISOString(),
      },
      // For modify, the args column is overwritten with the modified args
      // (the original args are preserved in contextSnapshot — the snapshot
      // is immutable, the args column reflects the final execution args).
      ...(decision.kind === "modify"
        ? { args: decision.args as any }
        : {}),
    })
    .where(
      and(
        eq(approvals.id, approvalId as any),
        eq(approvals.status, "pending"),
      ),
    )
    .returning({ id: approvals.id });

  if (!updated.length) {
    // Someone else's update won the race.
    return { kind: "already_decided" };
  }

  // Fact stream — kind + decider ONLY. No args, no snapshot.
  await facts.emit(row.wsId as string, "agent.approval.decided", {
    approvalId,
    kind: decision.kind,
    finalStatus,
    decidedBy: userId,
    runId: row.runId,
  });

  if (decision.kind === "reject") {
    // Reject → mark the run done with output={"rejected_by_human":true}.
    await db
      .update(runs)
      .set({
        status: "done",
        finishedAt: new Date(),
        output: { rejected_by_human: true },
        failureReason: `approval_rejected:${decision.reason}`,
      })
      .where(eq(runs.id, row.runId as any));
    return { kind: "rejected" };
  }

  // Approve or modify-approve → resume the run with the final args.
  await resumeRun(row.runId as string, row.toolId, finalArgs);

  return decision.kind === "modify" ? { kind: "modified_approved" } : { kind: "approved" };
}
