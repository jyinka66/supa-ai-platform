/**
 * @supa/expenses/approval
 * ----------------------------------------------------------------
 * Approval flow, only for workspaces with team roles beyond
 *   owner: submit → owner approves/rejects (with note) →
 *   reimbursed (optional fact linking a payment). Solo workspaces
 *   never see the flow — the five-minutes-to-learn constraint
 *   means features for teams you don't have are noise. Approval
 *   transitions are activity facts, so the timeline on the
 *   expense (and on the customer-facing side of nothing — this
 *   stays internal) is complete without a separate audit log.
 * ----------------------------------------------------------------
 */

import type { WorkspaceId } from "@supa/workspace-core/workspace";
import type { Expense } from "./expense.js";

// ───────────────────────────────────────────────
// Approval gate — team-only
// ───────────────────────────────────────────────

/**
 * Check if the approval flow applies to a workspace. Only workspaces
 * with team roles beyond owner (member or viewer) see the approval
 * flow. Solo workspaces never see it — the five-minutes-to-learn
 * constraint means features for teams you don't have are noise.
 */
export function approvalFlowApplies(workspaceRoles: ReadonlySet<string>): boolean {
  // If the workspace has any role beyond "owner", the approval flow applies.
  return workspaceRoles.has("member") || workspaceRoles.has("viewer");
}

// ───────────────────────────────────────────────
// Approval decision
// ───────────────────────────────────────────────

export type ApprovalDecision = "approved" | "rejected";

/**
 * An approval decision. The owner approves or rejects with an
 * optional note. The decision is an ACTIVITY FACT — the timeline
 * on the expense is complete without a separate audit log.
 */
export interface ApprovalDecisionRecord {
  readonly expenseId: string;
  readonly wsId: WorkspaceId;
  readonly decision: ApprovalDecision;
  readonly note: string | null;
  readonly decidedBy: string;
  readonly decidedAt: number;
}

/**
 * Record an approval decision. Returns the decision record (to be
 * written as an activity fact) + the new expense status.
 *
 *   approved  → expense.status = "approved"
 *   rejected  → expense.status = "rejected"
 */
export function recordApprovalDecision(
  expense: Expense,
  decision: ApprovalDecision,
  decidedBy: string,
  note: string | null,
  now: number = Date.now(),
): { record: ApprovalDecisionRecord; expense: Expense } {
  // The expense must be in "recorded" status to be approved/rejected.
  if (expense.status !== "recorded") {
    throw new ApprovalFlowError(
      `expense ${expense.id} is in status ${expense.status}; approval requires "recorded" status`,
    );
  }
  const decisionRecord: ApprovalDecisionRecord = {
    expenseId: expense.id,
    wsId: expense.wsId,
    decision,
    note,
    decidedBy,
    decidedAt: now,
  };
  const newExpense = decision === "approved"
    ? { ...expense, status: "approved" as const, updatedAt: now }
    : { ...expense, status: "rejected" as const, updatedAt: now };
  return { record: decisionRecord, expense: newExpense };
}

export class ApprovalFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalFlowError";
  }
}

// ───────────────────────────────────────────────
// Reimbursement — linking a payment
// ───────────────────────────────────────────────

/**
 * A reimbursement record. Links an approved expense to a payment
 * (the owner paid themselves/staff back). The reimbursement is a
 * FACT — the owner's "what do I owe myself/staff" is a query over
 * approved-but-not-reimbursed expenses.
 */
export interface ReimbursementRecord {
  readonly expenseId: string;
  readonly wsId: WorkspaceId;
  /** Payment reference (e.g. bank transfer id, cash withdrawal id). */
  readonly paymentRef: string;
  readonly amount: import("@supa/money/money").Money;
  readonly reimbursedBy: string;
  readonly reimbursedAt: number;
}

/**
 * Record a reimbursement. The expense must be "approved" (owed).
 * After reimbursement, the expense is "reimbursed" (paid).
 */
export function recordReimbursement(
  expense: Expense,
  paymentRef: string,
  amount: import("@supa/money/money").Money,
  reimbursedBy: string,
  now: number = Date.now(),
): { record: ReimbursementRecord; expense: Expense } {
  if (expense.status !== "approved") {
    throw new ApprovalFlowError(
      `expense ${expense.id} is in status ${expense.status}; reimbursement requires "approved" status`,
    );
  }
  const record: ReimbursementRecord = {
    expenseId: expense.id,
    wsId: expense.wsId,
    paymentRef,
    amount,
    reimbursedBy,
    reimbursedAt: now,
  };
  const newExpense: Expense = {
    ...expense,
    status: "reimbursed",
    reimbursedAt: now,
    updatedAt: now,
  };
  return { record, expense: newExpense };
}

// ───────────────────────────────────────────────
// Approval activity facts — the timeline
// ───────────────────────────────────────────────

/**
 * Approval transitions are activity facts. The timeline on the
 * expense shows: "submitted by X · approved by Y (note) · reimbursed by Z"
 * — all from the same activity_facts table, no separate audit log.
 *
 * These kinds extend the ActivityKind enum from @supa/customers/activity.
 * The activity repository writes these in the same transaction as
 * the expense status update.
 */
export type ApprovalActivityKind =
  | "expense-submitted"
  | "expense-approved"
  | "expense-rejected"
  | "expense-reimbursed";

export interface ApprovalActivityInput {
  readonly expenseId: string;
  readonly wsId: WorkspaceId;
  readonly kind: ApprovalActivityKind;
  readonly actor: string;
  readonly note: string | null;
  readonly occurredAt: number;
}

/**
 * Build the activity fact for an approval decision.
 */
export function buildApprovalActivity(
  decision: ApprovalDecisionRecord,
): ApprovalActivityInput {
  return {
    expenseId: decision.expenseId,
    wsId: decision.wsId,
    kind: decision.decision === "approved" ? "expense-approved" : "expense-rejected",
    actor: decision.decidedBy,
    note: decision.note,
    occurredAt: decision.decidedAt,
  };
}

/**
 * Build the activity fact for a reimbursement.
 */
export function buildReimbursementActivity(
  reimbursement: ReimbursementRecord,
): ApprovalActivityInput {
  return {
    expenseId: reimbursement.expenseId,
    wsId: reimbursement.wsId,
    kind: "expense-reimbursed",
    actor: reimbursement.reimbursedBy,
    note: `Payment ref: ${reimbursement.paymentRef}`,
    occurredAt: reimbursement.reimbursedAt,
  };
}

// ───────────────────────────────────────────────
// Approval repository contract
// ───────────────────────────────────────────────

export interface ApprovalRepository {
  /** Submit an expense for approval (recorded → awaiting approval). */
  submit(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    expenseId: string,
  ): Promise<Expense>;

  /** Approve/reject an expense (with note). Writes activity fact in same tx. */
  decide(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    expenseId: string,
    decision: ApprovalDecision,
    note: string | null,
  ): Promise<{ expense: Expense; decisionRecord: ApprovalDecisionRecord }>;

  /** Record a reimbursement (links payment). Writes activity fact in same tx. */
  reimburse(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    expenseId: string,
    paymentRef: string,
    amount: import("@supa/money/money").Money,
  ): Promise<{ expense: Expense; reimbursementRecord: ReimbursementRecord }>;
}
