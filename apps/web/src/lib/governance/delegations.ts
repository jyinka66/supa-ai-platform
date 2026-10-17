// Delegations — explicit delegation of irreversible actions.
// Periodic review, scope-limited, condition-gated, revocable.

import { db } from "@supa/db";
import { governanceDelegations } from "@supa/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { adminAudit } from "@/lib/admin/audit";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type DelegationScope = "global" | "workspace" | "region" | "vertical";
export type DelegationStatus = "active" | "revoked" | "expired";

export interface Delegation {
  id: string;
  actionType: string;
  targetType: string;
  delegatorId: string;
  delegateeId: string;
  scopeType: DelegationScope;
  scopeFilter: Record<string, unknown>;
  conditions: Record<string, unknown>;
  status: DelegationStatus;
  expiresAt: Date | null;
  lastReviewedAt: Date;
  reviewIntervalDays: number;
}

// ───────────────────────────────────────────────
// createDelegation — delegate an irreversible action.
// ───────────────────────────────────────────────

export async function createDelegation(input: {
  actionType: string;
  targetType: string;
  delegatorId: string;
  delegateeId: string;
  scopeType: DelegationScope;
  scopeFilter?: Record<string, unknown>;
  conditions?: Record<string, unknown>;
  expiresAt?: Date;
  reviewIntervalDays?: number;
}): Promise<Delegation> {
  const rows = await db.insert(governanceDelegations).values({
    actionType: input.actionType,
    targetType: input.targetType,
    delegatorId: input.delegatorId,
    delegateeId: input.delegateeId,
    scopeType: input.scopeType,
    scopeFilter: input.scopeFilter ?? {},
    conditions: input.conditions ?? {},
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    reviewIntervalDays: input.reviewIntervalDays ?? 90,
  }).returning({ id: governanceDelegations.id });

  const id = rows[0]?.id as string;
  if (!id) throw new Error("delegation_insert_failed");

  await adminAudit({
    actor: "system",
    action: "governance.delegation.created",
    target: { delegationId: id, actionType: input.actionType, delegateeId: input.delegateeId },
    justification: `Delegation: ${input.delegatorId} → ${input.delegateeId} for ${input.actionType} (${input.scopeType})`,
  });

  return (await getDelegation(id))!;
}

// ───────────────────────────────────────────────
// hasDelegation — check if a delegation exists for an action.
// ───────────────────────────────────────────────

export async function hasDelegation(
  actionType: string,
  targetType: string,
  delegateeId: string,
): Promise<boolean> {
  const result = await db.execute(sql`
    select 1 from governance_delegations
    where action_type = ${actionType}
      and target_type = ${targetType}
      and delegatee_id = ${delegateeId}
      and status = 'active'
      and (expires_at is null or expires_at > now())
    limit 1
  `);
  return (result as unknown as Array<Record<string, unknown>>).length > 0;
}

// ───────────────────────────────────────────────
// revokeDelegation — revoke a delegation.
// ───────────────────────────────────────────────

export async function revokeDelegation(delegationId: string, revokedBy: string, reason: string): Promise<void> {
  await db.execute(sql`
    update governance_delegations
       set status = 'revoked', revoked_at = now(), revoked_reason = ${reason}
     where id = ${delegationId}::uuid and status = 'active'
  `);

  await adminAudit({
    actor: "system",
    action: "governance.delegation.revoked",
    target: { delegationId, revokedBy, reason },
    justification: `Delegation revoked by ${revokedBy}: ${reason}`,
  });
}

// ───────────────────────────────────────────────
// reviewDelegation — periodic review (mark as reviewed).
// ───────────────────────────────────────────────

export async function reviewDelegation(delegationId: string, reviewedBy: string, stillValid: boolean): Promise<void> {
  if (stillValid) {
    await db.execute(sql`
      update governance_delegations set last_reviewed_at = now() where id = ${delegationId}::uuid and status = 'active'
    `);
  } else {
    await revokeDelegation(delegationId, reviewedBy, "Periodic review: no longer needed");
  }
}

// ───────────────────────────────────────────────
// expireDelegations — cron: expire past-expiry delegations.
// ───────────────────────────────────────────────

export async function expireDelegations(): Promise<number> {
  const result = await db.execute(sql`
    update governance_delegations
       set status = 'expired'
     where status = 'active' and expires_at is not null and expires_at < now()
    returning id
  `);
  return (result as unknown as Array<{ id: string }>).length;
}

// ───────────────────────────────────────────────
// listOverdueReviews — delegations needing review.
// ───────────────────────────────────────────────

export async function listOverdueReviews(): Promise<Delegation[]> {
  const result = await db.execute(sql`
    select * from governance_delegations
    where status = 'active'
      and last_reviewed_at < now() - (review_interval_days || ' days')::interval
    order by last_reviewed_at asc
  `);

  return (result as unknown as Array<Record<string, unknown>>).map(mapRow);
}

// ───────────────────────────────────────────────
// Query helpers.
// ───────────────────────────────────────────────

export async function getDelegation(id: string): Promise<Delegation | null> {
  const rows = await db.select().from(governanceDelegations).where(eq(governanceDelegations.id, id as any)).limit(1);
  const row = rows[0];
  return row ? mapRow(row as unknown as Record<string, unknown>) : null;
}

function mapRow(row: Record<string, unknown>): Delegation {
  return {
    id: row.id as string,
    actionType: row.action_type as string,
    targetType: row.target_type as string,
    delegatorId: row.delegator_id as string,
    delegateeId: row.delegatee_id as string,
    scopeType: row.scope_type as DelegationScope,
    scopeFilter: (row.scope_filter as Record<string, unknown>) ?? {},
    conditions: (row.conditions as Record<string, unknown>) ?? {},
    status: row.status as DelegationStatus,
    expiresAt: (row.expires_at as Date | null) ?? null,
    lastReviewedAt: row.last_reviewed_at as Date,
    reviewIntervalDays: row.review_interval_days as number,
  };
}
