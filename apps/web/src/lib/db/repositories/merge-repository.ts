/**
 * MergeRepository — the real DB implementation.
 *
 * execute() is a FACT, not a destructive edit:
 *   1. archive the merged customer (status→archived)
 *   2. repoint all referencing rows (invoices, activities, deals)
 *      to the survivor — via customerRepo.repointReferences
 *   3. write an activity fact on the survivor's timeline
 *   4. write the merge record with a 30-day reversible window
 *
 * reverse() (within the 30-day window):
 *   1. un-archive the merged customer
 *   2. repoint references back to the merged customer
 *   3. mark the merge record reversedAt
 *
 * After 30 days, the merge is permanent but still auditable — the
 * merge record stays, the repointed rows have moved on. Same
 * philosophy as invoice voids: relationships never vanish, they
 * acquire history.
 */

import { randomUUID } from "node:crypto";

import { db } from "@supa/db";
import { mergeRecords, customers, activityFacts } from "@supa/db/schema";
import { eq, and, desc, or } from "drizzle-orm";
import {
  buildMergeRecord,
  reverseMerge,
  type MergeRecord,
  type MergePlan,
  type MergeRepository as IMergeRepository,
} from "@supa/customers/duplicates";
import type { CustomerRepository } from "@supa/customers/customer";
import type { Customer } from "@supa/customers/customer";
import type { WorkspaceScope } from "@supa/workspace-core/workspace";

function rowToMergeRecord(row: typeof mergeRecords.$inferSelect): MergeRecord {
  return {
    id: row.id,
    wsId: row.workspaceId as any,
    survivorId: row.survivorId,
    mergedId: row.mergedId,
    fieldResolutions: row.fieldResolutions as Record<string, "survivor" | "merged">,
    mergedAt: row.mergedAt.getTime(),
    reversibleUntil: row.reversibleUntil.getTime(),
    reversedAt: row.reversedAt?.getTime() ?? null,
  };
}

export class MergeRepositoryImpl implements IMergeRepository {
  constructor(private readonly customerRepo: CustomerRepository) {}

  async execute(
    scope: WorkspaceScope,
    plan: MergePlan,
  ): Promise<{ mergeRecord: MergeRecord; survivor: Customer }> {
    const now = Date.now();
    const mergeId = randomUUID();
    const mergeRecord = buildMergeRecord(plan, scope.wsId, mergeId, now);

    // 1. Archive the merged customer (status→archived). The merged
    //    customer is NOT deleted — it's soft-archived so the audit
    //    trail (invoices, activities) stays intact.
    await db
      .update(customers)
      .set({ status: "archived", archivedAt: new Date(now), updatedAt: new Date(now) })
      .where(
        and(eq(customers.id, plan.mergedId), eq(customers.workspaceId, scope.wsId as any)),
      );

    // 2. Repoint all referencing rows (invoices, activity_facts, deals)
    //    from the merged customer to the survivor.
    await this.customerRepo.repointReferences(scope, plan.mergedId, plan.survivorId);

    // 3. Write an activity fact on the survivor's timeline recording
    //    the merge. kind="note" + source="manual" because the
    //    ActivityKind enum doesn't have a "merge" variant — content
    //    carries the semantics.
    await db.insert(activityFacts).values({
      workspaceId: scope.wsId as any,
      customerId: plan.survivorId,
      kind: "note",
      content: `Merged customer ${plan.mergedId} into this customer`,
      occurredAt: new Date(now),
      actor: scope.accountId,
      source: "manual",
    });

    // 4. Write the merge record (the auditable FACT).
    const [row] = await db
      .insert(mergeRecords)
      .values({
        id: mergeId,
        workspaceId: scope.wsId as any,
        survivorId: plan.survivorId,
        mergedId: plan.mergedId,
        fieldResolutions: plan.fieldResolutions,
        mergedAt: new Date(now),
        reversibleUntil: new Date(mergeRecord.reversibleUntil),
      })
      .returning();
    if (!row) throw new Error("merge record insert failed");

    // Fetch the survivor customer via the injected repo (consistent
    // row→Customer mapping).
    const survivor = await this.customerRepo.findById(scope, plan.survivorId);
    if (!survivor) throw new Error(`survivor customer ${plan.survivorId} not found`);

    return { mergeRecord: rowToMergeRecord(row), survivor };
  }

  async reverse(scope: WorkspaceScope, mergeId: string): Promise<MergeRecord> {
    const [row] = await db
      .select()
      .from(mergeRecords)
      .where(
        and(eq(mergeRecords.id, mergeId), eq(mergeRecords.workspaceId, scope.wsId as any)),
      )
      .limit(1);
    if (!row) throw new Error(`merge record ${mergeId} not found`);

    const mergeRecord = rowToMergeRecord(row);
    const now = Date.now();
    // Throws MergeNotReversibleError if expired / already reversed.
    const reversed = reverseMerge(mergeRecord, now);

    // 1. Un-archive the merged customer (status→active).
    await db
      .update(customers)
      .set({ status: "active", archivedAt: null, updatedAt: new Date(now) })
      .where(
        and(eq(customers.id, mergeRecord.mergedId), eq(customers.workspaceId, scope.wsId as any)),
      );

    // 2. Repoint references back from survivor → merged.
    await this.customerRepo.repointReferences(scope, mergeRecord.survivorId, mergeRecord.mergedId);

    // 3. Mark the merge record reversed.
    await db
      .update(mergeRecords)
      .set({ reversedAt: new Date(now) })
      .where(
        and(eq(mergeRecords.id, mergeId), eq(mergeRecords.workspaceId, scope.wsId as any)),
      );

    return reversed;
  }

  async findById(scope: WorkspaceScope, id: string): Promise<MergeRecord | null> {
    const [row] = await db
      .select()
      .from(mergeRecords)
      .where(and(eq(mergeRecords.id, id), eq(mergeRecords.workspaceId, scope.wsId as any)))
      .limit(1);
    return row ? rowToMergeRecord(row) : null;
  }

  async listByCustomer(scope: WorkspaceScope, customerId: string): Promise<readonly MergeRecord[]> {
    const rows = await db
      .select()
      .from(mergeRecords)
      .where(
        and(
          eq(mergeRecords.workspaceId, scope.wsId as any),
          or(
            eq(mergeRecords.survivorId, customerId),
            eq(mergeRecords.mergedId, customerId),
          ),
        ),
      )
      .orderBy(desc(mergeRecords.mergedAt));
    return rows.map(rowToMergeRecord);
  }
}
