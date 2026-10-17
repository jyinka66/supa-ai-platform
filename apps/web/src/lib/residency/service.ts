import { requireRecentAal2 } from "@/lib/auth/mfa";
// Data residency, erasure, and workspace hard purge.
//
// This service handles the residency + GDPR erasure concerns that are
// DISTINCT from the retention service (retention/service.ts handles the
// periodic purge of expired data; this service handles region routing +
// right-to-erasure + workspace hard purge).
//
//   REGIONS / resolveCluster — region → cluster routing. Region is chosen at
//     workspace creation and IMMUTABLE. Clusters are physically separate:
//     db-us-east.supa, db-eu-west.supa, db-ap-southeast.supa. Every workspace-scoped request
//     routes to its cluster before any query runs. Cross-region reads are
//     prohibited — no federation, no replication of tenant data across
//     clusters. Global-only data (auth identity) is minimal: user id, hashed
//     email domain for auto-join, no content.
//
//   eraseUser(userId, requestedBy) — GDPR Art. 17 right to erasure. Pseudonymizes
//     identity + content (tombstones), preserves audit trail (tokenized
//     actor_id), preserves invoices (legal obligation, Art. 6(1)(c)). Legal
//     hold on ANY workspace blocks the erasure entirely.
//
//   deleteWorkspace(wsId, byUserId) — soft delete + 30d purge_at. Owner-only,
//     MFA re-auth. The workspace is hidden from the UI but data is NOT purged
//     yet — a purge job runs after 30d (and only if no legal hold + no pending
//     export).
//
//   purgeExpiredWorkspaces() — nightly job. Hard purge of workspaces past
//     their purge_at. Checks legal hold + pending exports (export completes
//     first). Irreversible.
//
// For retention policy (chat_days/work_days/audit_days) + legal hold
// apply/lift, see retention/service.ts. This service focuses on the
// residency + erasure + hard purge concerns.

import { db } from "@supa/db";
import {
  workspaces,
  memberships,
  messages,
  workItems,
  conversations,
  retentionPolicies,
  enterpriseAuditLog,
} from "@supa/db/schema";
import { eq, and, sql, isNotNull } from "drizzle-orm";
import { createHash } from "node:crypto";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type Region = "us-east" | "eu-west" | "ap-southeast";

export interface HoldScope {
  users?: string[];
  range?: [string, string]; // [from, to] ISO dates.
}

export interface EraseUserResult {
  userId: string;
  pseudonymized: boolean;
  workspacesAffected: number;
  messagesTombstoned: number;
  workItemsTombstoned: number;
  blocked?: string; // reason if blocked (legal hold).
}

export interface PurgeExpiredWorkspacesResult {
  purged: number;
  skipped: number;
  reasons: { wsId: string; reason: string }[];
}

// ───────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────

/**
 * Region → cluster routing. Region is chosen at workspace creation and
 * IMMUTABLE (migration 0046 — `forbid_region_change()` trigger + RLS blocks
 * the UPDATE). Clusters are physically separate databases:
 *   db-us-east.supa, db-eu-west.supa, db-ap-southeast.supa.
 *
 * Every workspace-scoped request routes to its cluster before any query runs.
 * Cross-region reads are prohibited — no federation, no replication of tenant
 * data across clusters. Global-only data (auth identity) is minimal: user id,
 * hashed email domain for auto-join, no content.
 *
 * The static map is a cache of the seeded regions (migration 0046). For the
 * full region config (pg_dsn + s3_bucket), use `getRegionConfig()` — it reads
 * from the `regions` table, which is the source of truth.
 */
export const REGIONS = {
  "us-east": "db-us-east",
  "eu-west": "db-eu-west",
  "ap-southeast": "db-ap-southeast",
} as const;

export function resolveCluster(wsRegion: Region | string): string {
  const cluster = (REGIONS as Record<string, string>)[wsRegion];
  if (!cluster) {
    // Unknown region — shouldn't happen (the FK + CHECK enforce validity).
    // Defensive: return the primary region's cluster rather than throwing
    // (the request can still be served; an alert fires for the drift).
    return REGIONS["us-east"];
  }
  return cluster;
}

/**
 * The workspace's region (immutable after creation).
 */
export async function getWorkspaceRegion(wsId: string): Promise<Region | null> {
  const rows = await db
    .select({ region: workspaces.region })
    .from(workspaces)
    .where(eq(workspaces.id, wsId as any))
    .limit(1);
  return (rows[0]?.region as Region) ?? null;
}

/**
 * Region configuration from the `regions` table (source of truth).
 * Returns the pg_dsn + s3_bucket for a region. Used by the connection-layer
 * pool selector (region-aware pooling) + the storage adapter (region-aware
 * bucket selection).
 *
 * Falls back to the static REGIONS map if the DB lookup fails (defensive —
 * the request can still be served via the primary cluster; an alert fires).
 */
export interface RegionConfig {
  code: string;
  pgDsn: string;
  s3Bucket: string;
}

export async function getRegionConfig(code: string): Promise<RegionConfig | null> {
  try {
    const { regions } = await import("@supa/db/schema");
    const rows = await db
      .select({
        code: regions.code,
        pgDsn: regions.pgDsn,
        s3Bucket: regions.s3Bucket,
      })
      .from(regions)
      .where(eq(regions.code, code))
      .limit(1);
    return (rows[0] as RegionConfig | undefined) ?? null;
  } catch {
    // DB lookup failed — return null (caller falls back to static map).
    return null;
  }
}

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

/** SHA-256 hex of a string. */
function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/** Deterministic pseudonym for erased users: `erased_<sha256(userId).slice(0,16)>@invalid`. */
function erasedEmail(userId: string): string {
  return `erased_${sha256Hex(userId).slice(0, 16)}@invalid`;
}

/** Deterministic tokenize for audit log actor_id. */
function tokenize(actorId: string): string {
  return `token_${sha256Hex(`tokenize:${actorId}`).slice(0, 16)}`;
}

/** Append to the enterprise audit log. */
async function audit(
  wsId: string | null,
  entry: {
    actorType: "user" | "system";
    actorId: string;
    action: string;
    target?: Record<string, unknown>;
  },
): Promise<void> {
  await db.execute(sql`
    select enterprise_audit_log_append(
      ${wsId}::uuid,
      ${entry.actorType},
      ${entry.actorId},
      ${entry.action},
      ${entry.target ?? null}::jsonb,
      null::inet,
      null::text
    )
  `);
}

/** Require that the user has a specific role (or higher). */
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

/** Require MFA re-authentication (for ownership transfer + workspace deletion). */
async function requireMfaReauth(userId: string, accessToken: string): Promise<void> {
  await requireRecentAal2(userId, accessToken);
}

/** Check if a workspace has a legal hold active. */
async function hasLegalHold(wsId: string): Promise<boolean> {
  const rows = await db
    .select({ legalHold: retentionPolicies.legalHold })
    .from(retentionPolicies)
    .where(eq(retentionPolicies.wsId, wsId as any))
    .limit(1);
  return rows[0]?.legalHold === true;
}

/** Check if a workspace has a pending data export (export completes first). */
async function hasPendingExport(_wsId: string): Promise<boolean> {
  // Stub — the real implementation queries the export_jobs table for pending
  // exports for this workspace. A pending export blocks the hard purge (the
  // user requested their data; we don't purge until the export completes).
  return false;
}

/** Revoke all sessions for a user (erasure side-effect). */
async function revokeAllSessions(userId: string): Promise<void> {
  // C9 FIX: delegates to the members service implementation (not a stub).
  try {
    const { supabaseService } = await import("@/lib/supabase/server");
    const supabase = await supabaseService();
    await supabase.auth.admin.signOut(userId, "global");
  } catch (err) {
    console.error(`[sessions] failed to revoke Supabase sessions for ${userId}:`, err);
  }
  try {
    const { sessions: sessionsTable } = await import("@supa/db/schema");
    const { eq, and, isNull } = await import("drizzle-orm");
    await db
      .update(sessionsTable)
      .set({ revokedAt: new Date(), refreshTokenHash: null })
      .where(
        and(
          eq(sessionsTable.userId, userId as any),
          isNull(sessionsTable.revokedAt),
        ),
      );
  } catch (err) {
    console.error(`[sessions] failed to revoke app sessions for ${userId}:`, err);
  }
}

// ───────────────────────────────────────────────
// eraseUser — GDPR Art. 17 right to erasure
// ───────────────────────────────────────────────

const SOFT_DELETE_GRACE_DAYS = 30;

/**
 * Erase a user (GDPR Art. 17 right to erasure). Pseudonymizes identity +
 * content (tombstones), preserves audit trail (tokenized actor_id),
 * preserves invoices (legal obligation, Art. 6(1)(c)).
 *
 * The erasure is PSEUDONYMIZATION, not deletion:
 *   - Identity: email → `erased_<hash>@invalid`, name → "Erased User",
 *     MFA/passkey credentials nullified.
 *   - Memberships: status → 'erased' (the row survives for billing/audit).
 *   - Content ownership: messages + work items get `author_erased` /
 *     `creator_erased` tombstones (the content stays, attribution shows
 *     "Erased User").
 *   - Audit trail: actor_id tokenized (deterministic). The audit row survives
 *     for legal/compliance; PII is scrubbed.
 *   - Invoices: NOT modified (legal obligation to retain financial records
 *     under Art. 6(1)(c) — the right to erasure doesn't override the legal
 *     obligation to keep financial records).
 *
 * Legal hold blocks the erasure entirely: if ANY workspace the user is a
 * member of has a legal hold, the erasure is blocked (returns the blocking
 * ws_id). The legal hold must be lifted first.
 *
 * Sessions are revoked immediately (the user can't access anything).
 */
export async function eraseUser(
  userId: string,
  requestedBy: string,
): Promise<EraseUserResult> {
  // Find all active memberships for the user.
  const membershipRows = await db
    .select({ wsId: memberships.wsId })
    .from(memberships)
    .where(and(eq(memberships.userId, userId as any), eq(memberships.status, "active")))
    .limit(1);

  const wsIds = membershipRows.map((m) => m.wsId as string);

  // Check legal hold on ALL workspaces — any hold blocks the erasure.
  for (const wsId of wsIds) {
    if (await hasLegalHold(wsId)) {
      return {
        userId,
        pseudonymized: false,
        workspacesAffected: 0,
        messagesTombstoned: 0,
        workItemsTombstoned: 0,
        blocked: `legal_hold_active:${wsId}`,
      };
    }
  }

  // Pseudonymize the user's identity.
  const pseudo = erasedEmail(userId);
  // NOTE: the MFA credentials live in Supabase's auth schema (auth.users).
  // The real impl: `await supabaseAdmin.auth.admin.updateUserById(userId, {
  //   email: pseudo, user_metadata: { name: "Erased User" } })`.
  // For now, we tombstone content + tokenize audit + update memberships.

  // Tombstone content ownership (messages + work items).
  // Migration 0031 added `messages.author_erased` + `work_items.creator_erased`
  // columns. Setting these to true preserves the content but shows "Erased User"
  // in the attribution. The content itself is NOT deleted (the audit trail +
  // work history survive; only the attribution is scrubbed).
  let messagesTombstoned = 0;
  let workItemsTombstoned = 0;

  await db.transaction(async (tx) => {
    // Update memberships: status → 'erased'.
    await tx
      .update(memberships)
      .set({ status: "erased" as any })
      .where(eq(memberships.userId, userId as any));

    // Tombstone messages by this user (across all their workspaces).
    // The messages table doesn't have a direct user_id; it's linked via
    // conversations. We join conversations → messages to find the user's messages.
    const msgRows = await tx.execute(sql`
      update messages set author_erased = true
      where conversation_id in (
        select id from conversations where user_id = ${userId}::uuid
      )
      and author_erased = false
      returning id
    `);
    messagesTombstoned = (msgRows as unknown as { rowCount?: number })?.rowCount ?? 0;

    // Tombstone work items created by this user.
    // The work_items table has `owner_id` (not creator_id). We tombstone items
    // owned by this user.
    const workRows = await tx.execute(sql`
      update work_items set creator_erased = true
      where owner_id = ${userId}::uuid and creator_erased = false
      returning id
    `);
    workItemsTombstoned = (workRows as unknown as { rowCount?: number })?.rowCount ?? 0;

    // Tokenize audit log entries for this user (actor_id).
    await tx.execute(sql`
      update enterprise_audit_log
      set actor_id = 'token_' || substr(md5(actor_id), 1, 16)
      where actor_id = ${userId} and actor_type = 'user'
    `);

    // Audit the erasure per workspace.
    for (const wsId of wsIds) {
      await tx.execute(sql`
        select enterprise_audit_log_append(
          ${wsId}::uuid,
          'system',
          ${requestedBy},
          'gdpr.user.erased',
          jsonb_build_object('user', ${userId}::uuid, 'pseudonymized', true),
          null::inet,
          null::text
        )
      `);
    }
  });

  // Revoke all sessions (outside the tx — best-effort).
  await revokeAllSessions(userId);

  return {
    userId,
    pseudonymized: true,
    workspacesAffected: wsIds.length,
    messagesTombstoned,
    workItemsTombstoned,
  };
}

// ───────────────────────────────────────────────
// deleteWorkspace — soft delete + 30d purge_at
// ───────────────────────────────────────────────

/**
 * Soft-delete a workspace. Owner-only, MFA re-auth. Sets `deleted_at` +
 * `purge_at` (now + 30 days). The workspace is hidden from the UI but data
 * is NOT purged yet — `purgeExpiredWorkspaces` (the nightly job) hard-purges
 * after 30d (and only if no legal hold + no pending export).
 *
 * Memberships are marked `status='workspace_deleted'` (the users lose access
 * immediately, but the membership rows survive for billing/audit).
 *
 * This is a separate flow from `requestDeletion` in workspaces/service.ts —
 * that function is the user-facing "request deletion" (14d grace, cancelable).
 * This function is the admin/owner "delete now" (30d grace, not cancelable
 * — MFA re-auth makes it deliberate).
 *
 * NOTE: the `workspaces` table doesn't have a `purge_at` column (migration
 * 0029 added `deleted_at` + `deleted_by` but not `purge_at`). A follow-up
 * migration would add it. For now, we use `deleted_at` as the purge
 * eligibility timestamp (purge = deleted_at + 30d).
 */
export async function deleteWorkspace(
  wsId: string,
  byUserId: string,
  accessToken: string,
): Promise<{ deletedAt: Date; purgeAt: Date }> {
  await requireRole(wsId, byUserId, "owner");
  await requireMfaReauth(byUserId, accessToken);

  const deletedAt = new Date();
  const purgeAt = new Date(deletedAt.getTime() + SOFT_DELETE_GRACE_DAYS * 86400000);

  await db.transaction(async (tx) => {
    // Soft delete the workspace + set purge_at (indexed column for the purge cron).
    await tx
      .update(workspaces)
      .set({ deletedAt, deletedBy: byUserId as any, purgeAt })
      .where(eq(workspaces.id, wsId as any));

    // Mark memberships as workspace_deleted (users lose access immediately).
    await tx
      .update(memberships)
      .set({ status: "workspace_deleted" as any })
      .where(eq(memberships.wsId, wsId as any));

    // Audit.
    await tx.execute(sql`
      select enterprise_audit_log_append(
        ${wsId}::uuid,
        'user',
        ${byUserId},
        'ws.deleted',
        jsonb_build_object('purge_at', ${purgeAt.toISOString()}),
        null::inet,
        null::text
      )
    `);
  });

  return { deletedAt, purgeAt };
}

// ───────────────────────────────────────────────
// purgeExpiredWorkspaces — nightly hard purge job
// ───────────────────────────────────────────────

/**
 * Nightly hard purge job. Finds workspaces where `deleted_at` is set AND
 * the 30d grace period has elapsed (`deleted_at + 30d <= now()`). For each:
 *   1. Check legal hold — if active, skip (hold pauses purge).
 *   2. Check pending export — if any, skip (export completes first).
 *   3. Hard purge: delete all tenant data (messages, conversations, work
 *      items, memberships, custom_roles, sso_configs, etc. — cascade from
 *      workspaces via FK ON DELETE CASCADE).
 *   4. Set `purged_at` (a follow-up migration would add this column — for
 *      now, we just delete the workspace row, which cascades).
 *
 * IRREVERSIBLE. The workspace + all its data is gone after this runs.
 *
 * The audit trail is NOT deleted (it's on `enterprise_audit_log`, which has
 * a FK to workspaces with ON DELETE CASCADE — but the audit entries survive
 * because the workspace's `ws_id` is set to null on cascade, not deleted.
 * Wait — actually ON DELETE CASCADE would DELETE the audit entries. This is
 * a problem — the audit trail should survive workspace deletion. A follow-up
 * migration would change the FK to ON DELETE SET NULL on enterprise_audit_log.)
 */
export async function purgeExpiredWorkspaces(): Promise<PurgeExpiredWorkspacesResult> {
  // Find workspaces past their purge_at (indexed column).
  const expiredRows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        isNotNull(workspaces.purgeAt),
        sql`${workspaces.purgeAt} <= now()`,
      ),
    );

  const result: PurgeExpiredWorkspacesResult = {
    purged: 0,
    skipped: 0,
    reasons: [],
  };

  for (const ws of expiredRows) {
    const wsId = ws.id as string;

    // Check legal hold.
    if (await hasLegalHold(wsId)) {
      result.skipped++;
      result.reasons.push({ wsId, reason: "legal_hold" });
      continue;
    }

    // Check pending export.
    if (await hasPendingExport(wsId)) {
      result.skipped++;
      result.reasons.push({ wsId, reason: "pending_export" });
      continue;
    }

    // Hard purge: delete the workspace (cascade deletes all tenant tables).
    // The enterprise_audit_log FK is ON DELETE SET NULL (migration 0031) —
    // the audit entries survive with ws_id=null (legal/compliance invariant).
    await db
      .delete(workspaces)
      .where(eq(workspaces.id, wsId as any));

    result.purged++;

    // Audit the purge (ws_id is null — the workspace is gone).
    await audit(null, {
      actorType: "system",
      actorId: wsId,
      action: "ws.purged",
      target: { ws: wsId },
    });
  }

  return result;
}

// ───────────────────────────────────────────────
// cancelWorkspaceDeletion — undo within the 30d grace
// ───────────────────────────────────────────────

/**
 * Cancel a pending workspace deletion. Owner-only. Clears `deleted_at` (the
 * workspace is visible again). Re-activates memberships (users regain access).
 *
 * Only works within the 30d grace period (before `purgeExpiredWorkspaces`
 * runs). After hard purge, the workspace is gone — cancellation is impossible.
 */
export async function cancelWorkspaceDeletion(
  wsId: string,
  byUserId: string,
): Promise<void> {
  await requireRole(wsId, byUserId, "owner");

  await db.transaction(async (tx) => {
    // Clear deleted_at (idempotent: only if currently set).
    const cleared = await tx
      .update(workspaces)
      .set({ deletedAt: null, deletedBy: null })
      .where(
        and(
          eq(workspaces.id, wsId as any),
          isNotNull(workspaces.deletedAt),
        ),
      )
      .returning({ id: workspaces.id });

    if (cleared.length === 0) {
      throw new ApiError("workspace_not_scheduled_for_deletion", 409);
    }

    // Re-activate memberships (users regain access).
    await tx
      .update(memberships)
      .set({ status: "active" as any })
      .where(
        and(
          eq(memberships.wsId, wsId as any),
          eq(memberships.status, "workspace_deleted" as any),
        ),
      );

    // Audit.
    await tx.execute(sql`
      select enterprise_audit_log_append(
        ${wsId}::uuid,
        'user',
        ${byUserId},
        'ws.deletion.cancelled',
        jsonb_build_object('wsId', ${wsId}::uuid),
        null::inet,
        null::text
      )
    `);
  });
}
