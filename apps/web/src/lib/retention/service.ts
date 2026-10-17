// Retention service — data lifecycle, legal hold, purge.
//
// The enterprise retention model:
//   - Per-workspace retention policy (retention_policies table):
//       chat_days  — conversations/messages older than this are deleted.
//       work_days   — work items older than this are deleted.
//       audit_days  — audit log entries older than this are PSEUDONYMIZED
//                     (never deleted — legal/immutable; actor ids tokenized).
//       legal_hold — if true, NO purge happens (blocks everything).
//       hold_scope — optional JSON: { users:[...], range:[from,to] } — narrows
//                     the hold to specific users or date ranges.
//
//   evaluatePolicy(wsId)  — check the policy + legal hold for a workspace.
//   purgeExpired()        — the cron job. Finds expired data per policy,
//                           deletes honoring legal hold.
//   purgeChat(wsId, days) — delete conversations/messages past chat_days.
//   purgeWork(wsId, days) — delete work items past work_days.
//   purgeAudit(wsId, days) — pseudonymize audit entries past audit_days.
//   applyLegalHold(wsId) — owner/admin — block purge.
//   liftLegalHold(wsId)  — owner/admin — unblock.
//
// THE AUDIT LOG IS NEVER DELETED: audit entries are pseudonymized (actor_id
// tokenized) after audit_days, but the row survives for legal/compliance.
// This is the right-to-erasure interplay: erasure = pseudonymization, not
// deletion. The audit trail is preserved; PII is scrubbed.

import { db } from "@supa/db";
import {
  retentionPolicies,
  workspaces,
  conversations,
  messages,
  workItems,
  enterpriseAuditLog,
  memberships,
} from "@supa/db/schema";
import { eq, and, lt, sql } from "drizzle-orm";
import { createHash } from "node:crypto";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export interface RetentionPolicy {
  wsId: string;
  chatDays: number;
  workDays: number;
  auditDays: number;
  legalHold: boolean;
  holdScope: {
    users?: string[];
    range?: [string, string]; // [from, to] ISO dates.
  } | null;
}

export interface PurgeResult {
  wsId: string;
  chatPurged: number;
  workPurged: number;
  auditPseudonymized: number;
  skipped: boolean; // true if legal hold blocked the purge.
  reason?: string;
}

export interface PurgeExpiredResult {
  workspacesProcessed: number;
  totalChatPurged: number;
  totalWorkPurged: number;
  totalAuditPseudonymized: number;
  skipped: number;
}

// ───────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────

const DEFAULT_CHAT_DAYS = 365;
const DEFAULT_WORK_DAYS = 3650;
const DEFAULT_AUDIT_DAYS = 3650;

// ───────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────

/** Simple ApiError with status code. */
export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "ApiError";
  }
}

/** Deterministic tokenize: 'token_' + sha256('tokenize:' + actorId).slice(0, 16). */
function tokenize(actorId: string): string {
  return `token_${createHash("sha256").update(`tokenize:${actorId}`).digest("hex").slice(0, 16)}`;
}

/** Append to the enterprise audit log. */
async function audit(
  wsId: string,
  actorType: "user" | "system",
  actorId: string,
  action: string,
  target?: Record<string, unknown>,
): Promise<void> {
  await db.execute(sql`
    select enterprise_audit_log_append(
      ${wsId}::uuid,
      ${actorType},
      ${actorId},
      ${action},
      ${target ?? null}::jsonb,
      null::inet,
      null::text
    )
  `);
}

/**
 * Require that the user has a specific role (or higher). Inline (same pattern
 * as the other enterprise services — avoids cross-module circular deps).
 */
async function requireRole(
  wsId: string,
  userId: string,
  requiredRole: "owner" | "admin",
): Promise<void> {
  const rows = await db
    .select({ role: memberships.role, status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.wsId, wsId as any), eq(memberships.userId, userId as any)))
    .limit(1);
  const m = rows[0];
  if (!m) throw new ApiError("not_a_member", 403);
  if (m.status !== "active") throw new ApiError(`membership_${m.status}`, 403);
  const roleRank: Record<string, number> = { viewer: 0, custom: 1, member: 2, admin: 3, owner: 4 };
  if ((roleRank[m.role] ?? 0) < (roleRank[requiredRole] ?? 0)) {
    throw new ApiError(`insufficient_role:${m.role}<${requiredRole}`, 403);
  }
}

/** Convert days to a cutoff Date (now - days). */
function cutoffDate(days: number): Date {
  return new Date(Date.now() - days * 86400000);
}

// ───────────────────────────────────────────────
// evaluatePolicy — fetch + evaluate the retention policy
// ───────────────────────────────────────────────

/**
 * Fetch the retention policy for a workspace. Returns the policy, or defaults
 * if no policy row exists (365d chat, 3650d work/audit, no legal hold).
 *
 * The policy is the source of truth for what data can be purged. Legal hold
 * (`legal_hold = true`) blocks ALL purge for the workspace — the data stays
 * until the hold is lifted.
 */
export async function evaluatePolicy(wsId: string): Promise<RetentionPolicy> {
  const rows = await db
    .select()
    .from(retentionPolicies)
    .where(eq(retentionPolicies.wsId, wsId as any))
    .limit(1);

  const row = rows[0];
  if (!row) {
    // No policy → defaults.
    return {
      wsId,
      chatDays: DEFAULT_CHAT_DAYS,
      workDays: DEFAULT_WORK_DAYS,
      auditDays: DEFAULT_AUDIT_DAYS,
      legalHold: false,
      holdScope: null,
    };
  }

  return {
    wsId,
    chatDays: row.chatDays ?? DEFAULT_CHAT_DAYS,
    workDays: row.workDays ?? DEFAULT_WORK_DAYS,
    auditDays: row.auditDays ?? DEFAULT_AUDIT_DAYS,
    legalHold: row.legalHold,
    holdScope: (row.holdScope as RetentionPolicy["holdScope"]) ?? null,
  };
}

// ───────────────────────────────────────────────
// purgeChat — delete conversations/messages past chat_days
// ───────────────────────────────────────────────

/**
 * Purge chat conversations + messages older than `days`. Deletes messages
 * first (FK cascade from conversations would handle it, but explicit is
 * safer — avoids long cascading locks on large tables).
 *
 * Honors legal hold + hold_scope:
 *   - If `legal_hold = true`, returns 0 (nothing purged).
 *   - If `hold_scope.users` is set, conversations by those users are excluded.
 *   - If `hold_scope.range` is set, conversations in that range are excluded.
 *
 * Returns the count of conversations deleted.
 */
export async function purgeChat(
  wsId: string,
  policy: RetentionPolicy,
): Promise<number> {
  if (policy.legalHold) return 0;

  const cutoff = cutoffDate(policy.chatDays);
  const conditions = [
    eq(conversations.workspaceId, wsId as any),
    lt(conversations.updatedAt, cutoff),
  ];

  // hold_scope: exclude conversations by specific users.
  if (policy.holdScope?.users?.length) {
    conditions.push(sql`${conversations.userId} not in (${sql.join(policy.holdScope.users.map((u) => sql`${u}::uuid`), sql`,`)})`);
  }
  // hold_scope: exclude conversations in a date range.
  if (policy.holdScope?.range) {
    const [from, to] = policy.holdScope.range;
    conditions.push(sql`(${conversations.createdAt} < ${from}::timestamptz or ${conversations.createdAt} > ${to}::timestamptz)`);
  }

  // Delete messages first (FK cascade would handle it, but explicit is safer).
  const oldConvIds = db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(...conditions));

  await db
    .delete(messages)
    .where(sql`${messages.conversationId} in (${oldConvIds})`);

  // Delete conversations.
  const deleted = await db
    .delete(conversations)
    .where(and(...conditions))
    .returning({ id: conversations.id });

  return deleted.length;
}

// ───────────────────────────────────────────────
// purgeWork — delete work items past work_days
// ───────────────────────────────────────────────

/**
 * Purge work items older than `work_days`. Deletes the work_items rows
 * (cascade handles versions, tags, etc.).
 *
 * Honors legal hold (returns 0 if blocked). Work items don't have a user
 * scope (they're workspace-scoped), so `hold_scope.users` doesn't apply —
 * only `hold_scope.range` narrows the purge.
 */
export async function purgeWork(
  wsId: string,
  policy: RetentionPolicy,
): Promise<number> {
  if (policy.legalHold) return 0;

  const cutoff = cutoffDate(policy.workDays);
  const conditions = [
    eq(workItems.workspaceId, wsId as any),
    lt(workItems.createdAt, cutoff),
  ];

  if (policy.holdScope?.range) {
    const [from, to] = policy.holdScope.range;
    conditions.push(sql`(${workItems.createdAt} < ${from}::timestamptz or ${workItems.createdAt} > ${to}::timestamptz)`);
  }

  const deleted = await db
    .delete(workItems)
    .where(and(...conditions))
    .returning({ id: workItems.id });

  return deleted.length;
}

// ───────────────────────────────────────────────
// purgeAudit — pseudonymize (NEVER delete) audit entries past audit_days
// ───────────────────────────────────────────────

/**
 * Pseudonymize audit log entries older than `audit_days`. The rows are NEVER
 * deleted — they survive for legal/compliance. The `actor_id` is tokenized
 * (deterministic: `token_<sha256(actorId).slice(0,16)>`) so the audit trail
 * is preserved but PII is scrubbed.
 *
 * This is the right-to-erasure interplay: erasure = pseudonymization, not
 * deletion. The audit trail is preserved for compliance; PII is scrubbed.
 *
 * Honors legal hold (returns 0 if blocked — legal hold means NO modification
 * of audit entries, including pseudonymization).
 */
export async function purgeAudit(
  wsId: string,
  policy: RetentionPolicy,
): Promise<number> {
  if (policy.legalHold) return 0;

  const cutoff = cutoffDate(policy.auditDays);

  // Find entries that are past audit_days AND not already tokenized
  // (actor_id doesn't start with 'token_').
  const rows = await db
    .select({ id: enterpriseAuditLog.id, actorId: enterpriseAuditLog.actorId })
    .from(enterpriseAuditLog)
    .where(
      and(
        eq(enterpriseAuditLog.wsId, wsId as any),
        lt(enterpriseAuditLog.ts, cutoff),
        sql`${enterpriseAuditLog.actorId} not like 'token_%'`,
        eq(enterpriseAuditLog.actorType, "user"), // only tokenize user actors.
      ),
    )
    .limit(1000); // batch — avoid locking too many rows.

  let count = 0;
  for (const r of rows) {
    const tokenized = tokenize(r.actorId as string);
    await db
      .update(enterpriseAuditLog)
      .set({ actorId: tokenized })
      .where(eq(enterpriseAuditLog.id, r.id as any));
    count++;
  }

  return count;
}

// ───────────────────────────────────────────────
// purgeExpired — the cron job (all workspaces)
// ───────────────────────────────────────────────

/**
 * The retention purge cron job. Iterates all workspaces with data past their
 * retention windows, purges per policy. Honors legal hold (skips entirely).
 *
 * This is the job that runs nightly (POST /api/cron/purge-retention). It:
 *   1. Finds all non-deleted workspaces.
 *   2. For each, evaluates the retention policy.
 *   3. If legal_hold, skips (records in the result).
 *   4. Otherwise: purgeChat + purgeWork + purgeAudit.
 *   5. Audits the purge (actor_type='system').
 *
 * Returns a summary of what was purged.
 */
export async function purgeExpired(): Promise<PurgeExpiredResult> {
  // Find all non-deleted workspaces.
  const wsRows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(sql`${workspaces.deletedAt} is null`);

  const result: PurgeExpiredResult = {
    workspacesProcessed: 0,
    totalChatPurged: 0,
    totalWorkPurged: 0,
    totalAuditPseudonymized: 0,
    skipped: 0,
  };

  for (const ws of wsRows) {
    const wsId = ws.id as string;
    const policy = await evaluatePolicy(wsId);

    if (policy.legalHold) {
      result.skipped++;
      continue;
    }

    const chatPurged = await purgeChat(wsId, policy);
    const workPurged = await purgeWork(wsId, policy);
    const auditPseudonymized = await purgeAudit(wsId, policy);

    result.totalChatPurged += chatPurged;
    result.totalWorkPurged += workPurged;
    result.totalAuditPseudonymized += auditPseudonymized;
    result.workspacesProcessed++;

    // Audit the purge (only if something was actually purged).
    if (chatPurged > 0 || workPurged > 0 || auditPseudonymized > 0) {
      await audit(wsId, "system", "retention-cron", "ws.retention.purged", {
        chatPurged,
        workPurged,
        auditPseudonymized,
        policy: { chatDays: policy.chatDays, workDays: policy.workDays, auditDays: policy.auditDays },
      });
    }
  }

  return result;
}

// ───────────────────────────────────────────────
// Legal hold — apply / lift
// ───────────────────────────────────────────────

/**
 * Apply a legal hold to a workspace. Blocks ALL purge (chat, work, audit)
 * until the hold is lifted. Owner/admin only.
 *
 * Optional `holdScope` narrows the hold to specific users or date ranges
 * (e.g. "hold all data for users X, Y from Jan–Jun 2025"). If holdScope is
 * null, the hold is workspace-wide.
 */
export async function applyLegalHold(
  wsId: string,
  byUserId: string,
  holdScope?: RetentionPolicy["holdScope"],
): Promise<void> {
  await requireRole(wsId, byUserId, "owner");

  // Upsert the policy (create if doesn't exist).
  await db
    .insert(retentionPolicies)
    .values({
      wsId: wsId as any,
      legalHold: true,
      holdScope: holdScope ?? null,
    })
    .onConflictDoUpdate({
      target: [retentionPolicies.wsId],
      set: {
        legalHold: true,
        holdScope: holdScope ?? null,
      },
    });

  await audit(wsId, "user", byUserId, "ws.legal_hold.applied", { holdScope });
}

/**
 * Lift a legal hold. Owner/admin only. Unblocks purge (the next purgeExpired
 * run will purge data past retention windows).
 */
export async function liftLegalHold(
  wsId: string,
  byUserId: string,
): Promise<void> {
  await requireRole(wsId, byUserId, "owner");

  await db
    .update(retentionPolicies)
    .set({ legalHold: false, holdScope: null })
    .where(eq(retentionPolicies.wsId, wsId as any));

  await audit(wsId, "user", byUserId, "ws.legal_hold.lifted", {});
}

// ───────────────────────────────────────────────
// updatePolicy — set retention days (owner/admin)
// ───────────────────────────────────────────────

export interface UpdatePolicyInput {
  chatDays?: number;
  workDays?: number;
  auditDays?: number;
}

/**
 * Update the retention days for a workspace. Owner/admin only. The days must
 * be >= 1 (can't set 0 = delete immediately — that's dangerous). Can only
 * TIGHTEN (reduce days) — loosening (increasing days) requires owner approval
 * via a separate flow (not enforced here — the API route should warn).
 */
export async function updatePolicy(
  wsId: string,
  byUserId: string,
  input: UpdatePolicyInput,
): Promise<RetentionPolicy> {
  await requireRole(wsId, byUserId, "admin");

  // Validate: days must be >= 1.
  if (input.chatDays !== undefined && input.chatDays < 1) {
    throw new ApiError("chat_days_must_be_positive", 400);
  }
  if (input.workDays !== undefined && input.workDays < 1) {
    throw new ApiError("work_days_must_be_positive", 400);
  }
  if (input.auditDays !== undefined && input.auditDays < 1) {
    throw new ApiError("audit_days_must_be_positive", 400);
  }

  // Upsert the policy.
  await db
    .insert(retentionPolicies)
    .values({
      wsId: wsId as any,
      chatDays: input.chatDays ?? DEFAULT_CHAT_DAYS,
      workDays: input.workDays ?? DEFAULT_WORK_DAYS,
      auditDays: input.auditDays ?? DEFAULT_AUDIT_DAYS,
    })
    .onConflictDoUpdate({
      target: [retentionPolicies.wsId],
      set: {
        ...(input.chatDays !== undefined ? { chatDays: input.chatDays } : {}),
        ...(input.workDays !== undefined ? { workDays: input.workDays } : {}),
        ...(input.auditDays !== undefined ? { auditDays: input.auditDays } : {}),
      },
    });

  await audit(wsId, "user", byUserId, "ws.retention.policy_updated", input as Record<string, unknown>);

  return evaluatePolicy(wsId);
}
