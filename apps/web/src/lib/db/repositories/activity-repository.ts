/**
 * ActivityRepository — the real DB implementation.
 *
 * The create() function writes an activity fact (system or manual).
 * editContent() enforces the 24h edit window for manual notes.
 * listByCustomer() returns the timeline (system + manual mixed).
 */

import { db } from "@supa/db";
import { activityFacts } from "@supa/db/schema";
import { eq, and, desc, lt } from "drizzle-orm";
import {
  createActivity,
  isEditable,
  editContent,
  type ActivityFact,
  type CreateActivityInput,
  type ActivityRepository as IActivityRepository,
} from "@supa/customers/activity";
import type { WorkspaceScope } from "@supa/workspace-core/workspace";

function rowToFact(row: typeof activityFacts.$inferSelect): ActivityFact {
  return {
    id: row.id,
    wsId: row.workspaceId as any,
    customerId: row.customerId,
    dealId: row.dealId,
    kind: row.kind as ActivityFact["kind"],
    refId: row.refId,
    content: row.content,
    occurredAt: row.occurredAt.getTime(),
    actor: row.actor,
    source: row.source,
    createdAt: row.createdAt.getTime(),
    editedAt: row.editedAt?.getTime() ?? null,
  };
}

export class ActivityRepositoryImpl implements IActivityRepository {
  async create(scope: WorkspaceScope, input: CreateActivityInput): Promise<ActivityFact> {
    const fact = createActivity(input);
    const [row] = await db
      .insert(activityFacts)
      .values({
        id: fact.id,
        workspaceId: scope.wsId as any,
        customerId: fact.customerId,
        dealId: fact.dealId,
        kind: fact.kind,
        refId: fact.refId,
        content: fact.content,
        occurredAt: new Date(fact.occurredAt),
        actor: fact.actor,
        source: fact.source,
      })
      .returning();
    if (!row) throw new Error("activity fact insert failed");
    return rowToFact(row);
  }

  async editContent(scope: WorkspaceScope, id: string, newContent: string): Promise<ActivityFact> {
    const [row] = await db
      .select()
      .from(activityFacts)
      .where(and(eq(activityFacts.id, id), eq(activityFacts.workspaceId, scope.wsId as any)))
      .limit(1);
    if (!row) throw new Error(`activity fact ${id} not found`);
    const fact = rowToFact(row);
    const now = Date.now();
    const updated = editContent(fact, newContent, now);

    await db
      .update(activityFacts)
      .set({ content: newContent, editedAt: new Date(now) })
      .where(and(eq(activityFacts.id, id), eq(activityFacts.workspaceId, scope.wsId as any)));

    return updated;
  }

  async listByCustomer(
    scope: WorkspaceScope,
    customerId: string,
    filter?: { kinds?: readonly ActivityFact["kind"][]; limit?: number; before?: number },
  ): Promise<readonly ActivityFact[]> {
    const conditions = [
      eq(activityFacts.workspaceId, scope.wsId as any),
      eq(activityFacts.customerId, customerId),
    ];
    if (filter?.before) {
      conditions.push(lt(activityFacts.occurredAt, new Date(filter.before)));
    }
    const rows = await db
      .select()
      .from(activityFacts)
      .where(and(...conditions))
      .orderBy(desc(activityFacts.occurredAt))
      .limit(filter?.limit ?? 50);
    return rows.map(rowToFact);
  }

  async listByDeal(scope: WorkspaceScope, dealId: string): Promise<readonly ActivityFact[]> {
    const rows = await db
      .select()
      .from(activityFacts)
      .where(and(eq(activityFacts.dealId, dealId), eq(activityFacts.workspaceId, scope.wsId as any)))
      .orderBy(desc(activityFacts.occurredAt));
    return rows.map(rowToFact);
  }

  async repointReferences(scope: WorkspaceScope, fromCustomerId: string, toCustomerId: string): Promise<void> {
    await db
      .update(activityFacts)
      .set({ customerId: toCustomerId })
      .where(and(eq(activityFacts.customerId, fromCustomerId), eq(activityFacts.workspaceId, scope.wsId as any)));
  }
}
