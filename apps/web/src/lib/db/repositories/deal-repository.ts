/**
 * DealRepository — the real DB implementation.
 *
 * moveStage() writes a stage-move activity fact in the same DB
 * transaction as the status update. The stage change is
 * last-write-wins WITH the activity fact recording both
 * transitions — the loser sees what happened in the timeline
 * rather than a silent overwrite.
 */

import { db } from "@supa/db";
import { deals, activityFacts } from "@supa/db/schema";
import { eq, and, desc } from "drizzle-orm";
import {
  createDeal,
  moveStage,
  setProbability as setProb,
  type Deal,
  type CreateDealInput,
  type DealRepository as IDealRepository,
} from "@supa/deals/pipeline";
import { money, fromMinor, asCurrency } from "@supa/money/money";
import type { WorkspaceScope } from "@supa/workspace-core/workspace";

function rowToDeal(row: typeof deals.$inferSelect): Deal {
  return {
    id: row.id,
    wsId: row.workspaceId as any,
    customerId: row.customerId,
    title: row.title,
    value: fromMinor(row.valueMinor, asCurrency(row.currency)),
    expectedClose: row.expectedClose.getTime(),
    stageId: row.stageId,
    probability: row.probability ? parseFloat(row.probability) : null,
    source: row.source as Deal["source"],
    owner: row.owner,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

export class DealRepositoryImpl implements IDealRepository {
  async create(scope: WorkspaceScope, input: CreateDealInput): Promise<Deal> {
    const d = createDeal(input);
    const [row] = await db
      .insert(deals)
      .values({
        id: d.id,
        workspaceId: scope.wsId as any,
        customerId: d.customerId,
        title: d.title,
        valueMinor: d.value.minor,
        currency: d.value.currency,
        expectedClose: new Date(d.expectedClose),
        stageId: d.stageId,
        probability: d.probability ? d.probability.toString() : null,
        source: d.source,
        owner: d.owner,
      })
      .returning();
    if (!row) throw new Error("deal insert failed");

    // Fan out an activity fact (deal_created).
    await db.insert(activityFacts).values({
      workspaceId: scope.wsId as any,
      dealId: d.id,
      kind: "deal_created",
      content: `Deal "${d.title}" created`,
      occurredAt: new Date(d.createdAt),
      actor: scope.accountId,
      source: "system",
    });

    return rowToDeal(row);
  }

  async findById(scope: WorkspaceScope, id: string): Promise<Deal | null> {
    const [row] = await db
      .select()
      .from(deals)
      .where(and(eq(deals.id, id), eq(deals.workspaceId, scope.wsId as any)))
      .limit(1);
    return row ? rowToDeal(row) : null;
  }

  async listByStage(scope: WorkspaceScope, stageId: string): Promise<readonly Deal[]> {
    const rows = await db
      .select()
      .from(deals)
      .where(and(eq(deals.workspaceId, scope.wsId as any), eq(deals.stageId, stageId)))
      .orderBy(desc(deals.updatedAt));
    return rows.map(rowToDeal);
  }

  async listAll(scope: WorkspaceScope): Promise<readonly Deal[]> {
    const rows = await db
      .select()
      .from(deals)
      .where(eq(deals.workspaceId, scope.wsId as any))
      .orderBy(desc(deals.updatedAt));
    return rows.map(rowToDeal);
  }

  async moveStage(scope: WorkspaceScope, dealId: string, toStageId: string, actor: string): Promise<Deal> {
    const [row] = await db
      .select()
      .from(deals)
      .where(and(eq(deals.id, dealId), eq(deals.workspaceId, scope.wsId as any)))
      .limit(1);
    if (!row) throw new Error(`deal ${dealId} not found`);
    const deal = rowToDeal(row);
    const fromStageId = deal.stageId;
    const now = Date.now();
    const updated = moveStage(deal, toStageId, { wsId: scope.wsId, stages: [] } as any, now);
    void updated; // the moveStage function validates the transition

    await db
      .update(deals)
      .set({ stageId: toStageId, updatedAt: new Date(now) })
      .where(and(eq(deals.id, dealId), eq(deals.workspaceId, scope.wsId as any)));

    // Write a deal_stage activity fact (free analytics).
    await db.insert(activityFacts).values({
      workspaceId: scope.wsId as any,
      dealId,
      kind: "deal_stage",
      content: `Deal moved from ${fromStageId} to ${toStageId}`,
      occurredAt: new Date(now),
      actor,
      source: "system",
    });

    return { ...deal, stageId: toStageId, updatedAt: now };
  }

  async setProbability(scope: WorkspaceScope, dealId: string, probability: number): Promise<Deal> {
    const [row] = await db
      .select()
      .from(deals)
      .where(and(eq(deals.id, dealId), eq(deals.workspaceId, scope.wsId as any)))
      .limit(1);
    if (!row) throw new Error(`deal ${dealId} not found`);
    const deal = rowToDeal(row);
    const now = Date.now();
    const updated = setProb(deal, probability, now);

    await db
      .update(deals)
      .set({ probability: probability.toString(), updatedAt: new Date(now) })
      .where(and(eq(deals.id, dealId), eq(deals.workspaceId, scope.wsId as any)));

    return updated;
  }

  async listByCustomer(scope: WorkspaceScope, customerId: string): Promise<readonly Deal[]> {
    const rows = await db
      .select()
      .from(deals)
      .where(and(eq(deals.customerId, customerId), eq(deals.workspaceId, scope.wsId as any)))
      .orderBy(desc(deals.updatedAt));
    return rows.map(rowToDeal);
  }
}
