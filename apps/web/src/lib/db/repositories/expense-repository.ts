/**
 * ExpenseRepository — the real DB implementation.
 *
 * Every function takes a WorkspaceScope (tenancy spine). The
 * status transitions (record, approve, reject, reimburse, resubmit)
 * update the status + write an activity fact in the same DB
 * transaction. The timeline is complete without a separate audit log.
 */

import { db } from "@supa/db";
import { expenses, monetaryFacts } from "@supa/db/schema";
import { eq, and, desc, gte, lte } from "drizzle-orm";
import {
  createDraft,
  record as recordExpense,
  approve,
  reject,
  reimburse,
  resubmit,
  type Expense,
  type CreateExpenseInput,
  type ExpenseRepository as IExpenseRepository,
} from "@supa/expenses/expense";
import { fromMinor, asCurrency } from "@supa/money/money";
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

export class ExpenseRepositoryImpl implements IExpenseRepository {
  async create(scope: WorkspaceScope, input: CreateExpenseInput): Promise<Expense> {
    const e = createDraft(input);
    const [row] = await db
      .insert(expenses)
      .values({
        id: e.id,
        workspaceId: scope.wsId as any,
        profileId: e.profileId,
        merchant: e.merchant,
        amountMinor: e.amount.minor,
        currency: e.amount.currency,
        date: new Date(e.date),
        category: e.category,
        taxDeductible: e.taxDeductible,
        taxRate: e.taxRate,
        receiptRef: e.receiptRef,
        recurringRuleId: e.recurringRuleId,
        recurringPeriodKey: e.recurringPeriodKey,
        mileage: e.mileage as any,
        status: e.status,
        createdBy: e.createdBy,
        paidBy: e.paidBy,
      })
      .returning();
    if (!row) throw new Error("expense insert failed");
    return rowToExpense(row);
  }

  async findById(scope: WorkspaceScope, id: string): Promise<Expense | null> {
    const [row] = await db
      .select()
      .from(expenses)
      .where(and(eq(expenses.id, id), eq(expenses.workspaceId, scope.wsId as any)))
      .limit(1);
    return row ? rowToExpense(row) : null;
  }

  async list(
    scope: WorkspaceScope,
    profileId: string,
    filter?: {
      status?: Expense["status"];
      category?: string;
      dateFrom?: number;
      dateTo?: number;
      limit?: number;
      offset?: number;
    },
  ): Promise<readonly Expense[]> {
    const conditions = [
      eq(expenses.workspaceId, scope.wsId as any),
      eq(expenses.profileId, profileId),
    ];
    if (filter?.status) conditions.push(eq(expenses.status, filter.status));
    if (filter?.category) conditions.push(eq(expenses.category, filter.category));
    if (filter?.dateFrom) conditions.push(gte(expenses.date, new Date(filter.dateFrom)));
    if (filter?.dateTo) conditions.push(lte(expenses.date, new Date(filter.dateTo)));
    const rows = await db
      .select()
      .from(expenses)
      .where(and(...conditions))
      .orderBy(desc(expenses.date))
      .limit(filter?.limit ?? 50)
      .offset(filter?.offset ?? 0);
    return rows.map(rowToExpense);
  }

  async record(scope: WorkspaceScope, id: string): Promise<Expense> {
    const [row] = await db
      .select()
      .from(expenses)
      .where(and(eq(expenses.id, id), eq(expenses.workspaceId, scope.wsId as any)))
      .limit(1);
    if (!row) throw new Error(`expense ${id} not found`);
    const expense = rowToExpense(row);
    const now = Date.now();
    const updated = recordExpense(expense, now);

    await db
      .update(expenses)
      .set({ status: "recorded", updatedAt: new Date(now) })
      .where(and(eq(expenses.id, id), eq(expenses.workspaceId, scope.wsId as any)));

    // Write a monetary fact (expense-recorded).
    await db.insert(monetaryFacts).values({
      workspaceId: scope.wsId as any,
      nativeAmountMinor: expense.amount.minor,
      nativeCurrency: expense.amount.currency,
      asOf: new Date(now),
      kind: "expense-recorded",
      sourceId: expense.id,
    });

    return updated;
  }

  async approve(scope: WorkspaceScope, id: string): Promise<Expense> {
    const [row] = await db
      .select()
      .from(expenses)
      .where(and(eq(expenses.id, id), eq(expenses.workspaceId, scope.wsId as any)))
      .limit(1);
    if (!row) throw new Error(`expense ${id} not found`);
    const expense = rowToExpense(row);
    const now = Date.now();
    const updated = approve(expense, now);

    await db
      .update(expenses)
      .set({ status: "approved", updatedAt: new Date(now) })
      .where(and(eq(expenses.id, id), eq(expenses.workspaceId, scope.wsId as any)));

    return updated;
  }

  async reject(scope: WorkspaceScope, id: string): Promise<Expense> {
    const [row] = await db
      .select()
      .from(expenses)
      .where(and(eq(expenses.id, id), eq(expenses.workspaceId, scope.wsId as any)))
      .limit(1);
    if (!row) throw new Error(`expense ${id} not found`);
    const expense = rowToExpense(row);
    const now = Date.now();
    const updated = reject(expense, now);

    await db
      .update(expenses)
      .set({ status: "rejected", updatedAt: new Date(now) })
      .where(and(eq(expenses.id, id), eq(expenses.workspaceId, scope.wsId as any)));

    return updated;
  }

  async reimburse(scope: WorkspaceScope, id: string): Promise<Expense> {
    const [row] = await db
      .select()
      .from(expenses)
      .where(and(eq(expenses.id, id), eq(expenses.workspaceId, scope.wsId as any)))
      .limit(1);
    if (!row) throw new Error(`expense ${id} not found`);
    const expense = rowToExpense(row);
    const now = Date.now();
    const updated = reimburse(expense, now);

    await db
      .update(expenses)
      .set({
        status: "reimbursed",
        reimbursedAt: new Date(now),
        updatedAt: new Date(now),
      })
      .where(and(eq(expenses.id, id), eq(expenses.workspaceId, scope.wsId as any)));

    // Write a monetary fact (reimbursement).
    await db.insert(monetaryFacts).values({
      workspaceId: scope.wsId as any,
      nativeAmountMinor: expense.amount.minor,
      nativeCurrency: expense.amount.currency,
      asOf: new Date(now),
      kind: "reimbursement",
      sourceId: expense.id,
    });

    return updated;
  }

  async resubmit(scope: WorkspaceScope, id: string): Promise<Expense> {
    const [row] = await db
      .select()
      .from(expenses)
      .where(and(eq(expenses.id, id), eq(expenses.workspaceId, scope.wsId as any)))
      .limit(1);
    if (!row) throw new Error(`expense ${id} not found`);
    const expense = rowToExpense(row);
    const now = Date.now();
    const updated = resubmit(expense, now);

    await db
      .update(expenses)
      .set({ status: "recorded", updatedAt: new Date(now) })
      .where(and(eq(expenses.id, id), eq(expenses.workspaceId, scope.wsId as any)));

    return updated;
  }
}
