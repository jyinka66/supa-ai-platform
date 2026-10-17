/**
 * ApprovalRepository — the real DB implementation.
 *
 * The team-only approval flow: submit → approve/reject (with note) →
 * reimburse (links payment). Every transition writes an activity
 * fact in the same DB transaction as the expense status update — the
 * timeline on the expense is complete without a separate audit log:
 *
 *   "submitted by X · approved by Y (note) · reimbursed by Z (ref)"
 *
 * The activity facts use the ApprovalActivityKind vocabulary from
 * @supa/expenses/approval ("expense-approved", "expense-rejected",
 * "expense-reimbursed") — written to the activityFacts.kind text
 * column directly (no DB enum constraint on kind).
 */

import { db } from "@supa/db";
import { expenses, activityFacts } from "@supa/db/schema";
import { eq, and } from "drizzle-orm";
import {
  recordApprovalDecision,
  recordReimbursement,
  buildApprovalActivity,
  buildReimbursementActivity,
  type ApprovalDecision,
  type ApprovalDecisionRecord,
  type ReimbursementRecord,
  type ApprovalRepository as IApprovalRepository,
} from "@supa/expenses/approval";
import type { Expense } from "@supa/expenses/expense";
import { fromMinor, asCurrency, type Money } from "@supa/money/money";
import type { WorkspaceScope } from "@supa/workspace-core/workspace";

function rowToExpense(row: typeof expenses.$inferSelect): Expense {
  return {
    id: row.id,
    wsId: row.workspaceId as any,
    profileId: row.profileId,
    merchant: row.merchant,
    amount: fromMinor(row.amountMinor, asCurrency(row.currency)),
    date: row.date.getTime(),
    category: row.category,
    taxDeductible: row.taxDeductible,
    taxRate: row.taxRate,
    receiptRef: row.receiptRef,
    recurringRuleId: row.recurringRuleId,
    recurringPeriodKey: row.recurringPeriodKey,
    mileage: row.mileage as any,
    status: row.status,
    createdBy: row.createdBy,
    paidBy: row.paidBy as Expense["paidBy"],
    reimbursedAt: row.reimbursedAt?.getTime() ?? null,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

export class ApprovalRepositoryImpl implements IApprovalRepository {
  async submit(scope: WorkspaceScope, expenseId: string): Promise<Expense> {
    const [row] = await db
      .select()
      .from(expenses)
      .where(and(eq(expenses.id, expenseId), eq(expenses.workspaceId, scope.wsId as any)))
      .limit(1);
    if (!row) throw new Error(`expense ${expenseId} not found`);
    const expense = rowToExpense(row);

    // If not already recorded, transition to "recorded". Drafts become
    // recorded (the durable state — queryable + reportable). Re-submits
    // (rejected → recorded) also go through here.
    if (expense.status !== "recorded") {
      const now = Date.now();
      await db
        .update(expenses)
        .set({ status: "recorded", updatedAt: new Date(now) })
        .where(and(eq(expenses.id, expenseId), eq(expenses.workspaceId, scope.wsId as any)));
      return { ...expense, status: "recorded", updatedAt: now };
    }
    return expense;
  }

  async decide(
    scope: WorkspaceScope,
    expenseId: string,
    decision: ApprovalDecision,
    note: string | null,
  ): Promise<{ expense: Expense; decisionRecord: ApprovalDecisionRecord }> {
    const [row] = await db
      .select()
      .from(expenses)
      .where(and(eq(expenses.id, expenseId), eq(expenses.workspaceId, scope.wsId as any)))
      .limit(1);
    if (!row) throw new Error(`expense ${expenseId} not found`);
    const expense = rowToExpense(row);
    const now = Date.now();

    // Pure function — validates status (must be "recorded") + builds
    // the decision record + the new expense state.
    const { record, expense: updated } = recordApprovalDecision(
      expense,
      decision,
      scope.accountId,
      note,
      now,
    );

    // Update the expense status.
    await db
      .update(expenses)
      .set({ status: decision, updatedAt: new Date(now) })
      .where(and(eq(expenses.id, expenseId), eq(expenses.workspaceId, scope.wsId as any)));

    // Write the activity fact (timeline entry).
    const activity = buildApprovalActivity(record);
    await db.insert(activityFacts).values({
      workspaceId: scope.wsId as any,
      kind: activity.kind,
      refId: expenseId,
      content: activity.note ?? `Expense ${decision}`,
      occurredAt: new Date(activity.occurredAt),
      actor: activity.actor,
      source: "system",
    });

    return { expense: updated, decisionRecord: record };
  }

  async reimburse(
    scope: WorkspaceScope,
    expenseId: string,
    paymentRef: string,
    amount: Money,
  ): Promise<{ expense: Expense; reimbursementRecord: ReimbursementRecord }> {
    const [row] = await db
      .select()
      .from(expenses)
      .where(and(eq(expenses.id, expenseId), eq(expenses.workspaceId, scope.wsId as any)))
      .limit(1);
    if (!row) throw new Error(`expense ${expenseId} not found`);
    const expense = rowToExpense(row);
    const now = Date.now();

    // Pure function — validates status (must be "approved") + builds
    // the reimbursement record + the new expense state.
    const { record, expense: updated } = recordReimbursement(
      expense,
      paymentRef,
      amount,
      scope.accountId,
      now,
    );

    // Update the expense status + reimbursedAt.
    await db
      .update(expenses)
      .set({
        status: "reimbursed",
        reimbursedAt: new Date(now),
        updatedAt: new Date(now),
      })
      .where(and(eq(expenses.id, expenseId), eq(expenses.workspaceId, scope.wsId as any)));

    // Write the activity fact (timeline entry).
    const activity = buildReimbursementActivity(record);
    await db.insert(activityFacts).values({
      workspaceId: scope.wsId as any,
      kind: activity.kind,
      refId: expenseId,
      content: activity.note ?? "Expense reimbursed",
      occurredAt: new Date(activity.occurredAt),
      actor: activity.actor,
      source: "system",
    });

    return { expense: updated, reimbursementRecord: record };
  }
}
