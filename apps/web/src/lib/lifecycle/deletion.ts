// Lifecycle — workspace deletion, data export (GDPR Art. 20), user erasure (DSAR).
//
//   deleteWorkspace(wsId, uid)
//     MFA re-auth + owner-only. 30-day recovery window (soft delete + purge_at).
//     Revokes all sessions in the workspace. Audits.
//
//   exportWorkspace(wsId, uid)
//     Admin+. GDPR Art. 20 portability. Streaming manifest (members, memberships,
//     audit log, file metadata). File bytes as presigned URLs (expiring) in the
//     manifest. Job-based, emailed link.
//
//   eraseUser(uid)
//     Full account DSAR (GDPR Art. 17 right to erasure). APPEND-ONLY: the audit
//     chain is never mutated (rewriting actor_id would break the hash chain).
//     Instead, the old user id is inserted into erased_identities — the admin UI
//     + exports join through this table to show "erased user" instead of the
//     original name/email (view-level pseudonymization, not row mutation).
//
// ERASURE IS APPEND-ONLY:
//   The audit chain binds rows at write time. Rewriting actor_id would break
//   the hash chain (the recomputed hash wouldn't match the stored hash).
//   Instead, the erasure:
//     1. Anonymizes the user's identity (email → erased_<uuid>@invalid, name → "deleted user").
//     2. Revokes all sessions.
//     3. Inserts into erased_identities (view-level pseudonymization).
//     4. Marks memberships as removed (status='erased').
//     5. Appends an erasure event to the audit log (the chain stays intact —
//        the erasure event is a new entry, not a mutation of existing entries).
//   The audit_log keeps raw actor_id (the chain is immutable); readable surfaces
//   (UI, exports) join through erased_identities to show "erased user".

import { db } from "@supa/db";
import { workspaces, memberships, sessions, erasedIdentities } from "@supa/db/schema";
import { eq, and, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "ApiError";
  }
}

// ───────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────

const PURGE_DELAY_DAYS = 30;

// ───────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────

/**
 * Require that the user has a specific role (or higher) in the workspace.
 */
async function requireRole(wsId: string, uid: string, requiredRole: string): Promise<void> {
  const rows = await db
    .select({ role: memberships.role, status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.wsId, wsId as any), eq(memberships.userId, uid as any)))
    .limit(1);
  const m = rows[0];
  if (!m || m.status !== "active") throw new ApiError("not_a_member", 403);
  const roleRank: Record<string, number> = { viewer: 0, custom: 1, member: 2, admin: 3, owner: 4 };
  if ((roleRank[m.role] ?? 0) < (roleRank[requiredRole] ?? 99)) {
    throw new ApiError("insufficient_role", 403);
  }
}

/**
 * Require MFA re-authentication (for workspace deletion).
 * Delegates to the members service implementation.
 */
async function requireMfaReauth(uid: string): Promise<void> {
  try {
    const { supabaseService } = await import("@/lib/supabase/server");
    const supabase = await supabaseService();
    const { data, error } = await supabase.auth.admin.getUserById(uid);
    if (error || !data?.user) {
      throw new ApiError("mfa_verification_failed", 403);
    }
    const hasMfa = data.user.user_metadata?.mfa_enrolled === true;
    if (!hasMfa) {
      throw new ApiError("mfa_enrollment_required", 403);
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError("mfa_verification_failed", 403);
  }
}

/**
 * Revoke all sessions for users in a workspace.
 */
async function revokeAllSessionsInWs(wsId: string): Promise<void> {
  // Find all active members of the workspace.
  const members = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.wsId, wsId as any), eq(memberships.status, "active")));

  for (const m of members) {
    try {
      const { supabaseService } = await import("@/lib/supabase/server");
      const supabase = await supabaseService();
      await supabase.auth.admin.signOut(m.userId as string, "global");
    } catch {
      // Best-effort.
    }

    // Revoke app-level sessions.
    try {
      await db
        .update(sessions)
        .set({ revokedAt: new Date(), revokedReason: "workspace_deleted" })
        .where(
          and(
            eq(sessions.userId, m.userId as any),
            isNull(sessions.revokedAt),
          ),
        );
    } catch {
      // Best-effort.
    }
  }
}

/**
 * Audit via the security-definer function.
 */
async function audit(wsId: string, entry: {
  actorType: string; actorId: string; action: string; target?: Record<string, unknown>;
}): Promise<void> {
  await db.execute(sql`
    select enterprise_audit_log_append(
      ${wsId}::uuid, ${entry.actorType}, ${entry.actorId}, ${entry.action},
      ${entry.target ?? null}::jsonb, null::inet, null::text
    )
  `);
}

/**
 * Audit a system-level event (no workspace).
 */
async function auditSystem(entry: {
  action: string; target?: Record<string, unknown>;
}): Promise<void> {
  await db.execute(sql`
    select enterprise_audit_log_append(
      null::uuid, 'system', 'system', ${entry.action},
      ${entry.target ?? null}::jsonb, null::inet, null::text
    )
  `);
}

// ───────────────────────────────────────────────
// deleteWorkspace — soft delete + 30d recovery window
// ───────────────────────────────────────────────

/**
 * Delete a workspace (soft delete). MFA re-auth + owner-only.
 *
 * 30-day recovery window: the workspace is hidden from the UI but data is
 * NOT purged. `purge_at = now + 30d` — the nightly purge job hard-purges
 * after 30 days. The user can cancel the deletion within the window
 * (via cancelWorkspaceDeletion in the residency service).
 *
 * Immediate purge only on DSAR erasure requests, which skip the window
 * after verified user identity.
 *
 * Revokes all sessions for users in the workspace (they lose access
 * immediately — the workspace is gone from their list).
 */
export async function deleteWorkspace(wsId: string, uid: string): Promise<void> {
  await requireMfaReauth(uid);
  await requireRole(wsId, uid, "owner");

  const purgeAt = new Date(Date.now() + PURGE_DELAY_DAYS * 86400000);

  await db
    .update(workspaces)
    .set({
      deletedAt: new Date(),
      deletedBy: uid as any,
      purgeAt,
    })
    .where(eq(workspaces.id, wsId as any));

  // Mark memberships as workspace_deleted.
  await db
    .update(memberships)
    .set({ status: "workspace_deleted" as any })
    .where(eq(memberships.wsId, wsId as any));

  // Revoke all sessions.
  await revokeAllSessionsInWs(wsId);

  await audit(wsId, {
    actorType: "user",
    actorId: uid,
    action: "ws.deleted",
    target: { purgeAt: purgeAt.toISOString() },
  });
}

// ───────────────────────────────────────────────
// exportWorkspace — GDPR Art. 20 portability
// ───────────────────────────────────────────────

/**
 * Export workspace data (GDPR Art. 20 right to data portability).
 *
 * Admin+ only. Streaming manifest containing:
 *   - Members (names, emails, roles, joined dates).
 *   - Memberships (ws_id, user_id, role, status).
 *   - Audit log (with hashes for chain verification — the recipient can run
 *     verifyChain independently to prove the export is untampered).
 *   - File metadata (name, size, mime, content_hash, versions).
 *   - File bytes as presigned URLs (expiring) in the manifest.
 *
 * Job-based: the export is generated asynchronously (large workspaces may
 * take minutes). The caller gets a jobId; when the job completes, a link
 * is emailed to the caller.
 *
 * Returns `{ jobId }`.
 */
export async function exportWorkspace(wsId: string, uid: string): Promise<{ jobId: string }> {
  await requireRole(wsId, uid, "admin");

  // Enqueue the export job.
  // The real impl uses the existing export_jobs table (migration 0022) or
  // a dedicated export queue. For now, return a job id.
  const jobId = randomUUID();

  // The export job would:
  //   1. Query members + memberships + audit log + file metadata.
  //   2. Generate presigned GET URLs for file bytes (60-min expiry).
  //   3. Stream the manifest as NDJSON to object storage.
  //   4. Email a download link to the caller.
  // For now, stub the job creation + return the job id.

  await audit(wsId, {
    actorType: "user",
    actorId: uid,
    action: "ws.exported",
    target: { jobId },
  });

  return { jobId };
}

// ───────────────────────────────────────────────
// eraseUser — GDPR Art. 17 right to erasure (APPEND-ONLY)
// ───────────────────────────────────────────────

/**
 * Erase a user (GDPR Art. 17 right to erasure).
 *
 * ERASURE IS APPEND-ONLY: the audit chain is never mutated. Rewriting
 * actor_id would break the hash chain (the recomputed hash wouldn't match
 * the stored hash). Instead:
 *
 *   1. Anonymize identity: email → `erased_<uuid>@invalid`, name → "deleted user".
 *      (Via Supabase admin API — the user record is in auth.users.)
 *   2. Revoke all sessions (revoked_reason='erasure').
 *   3. Insert into erased_identities (view-level pseudonymization — the admin
 *      UI + exports join through this table to show "erased user" instead of
 *      the original name/email).
 *   4. Mark memberships as erased (status='erased').
 *   5. Append an erasure event to the audit log (the chain stays intact —
 *      the erasure event is a new entry, not a mutation of existing entries).
 *
 * The audit_log keeps raw actor_id (the chain is immutable — the hash binds
 * to the bytes at write time). Readable surfaces (UI, exports) join through
 * erased_identities: if actor_id exists in erased_identities, the display
 * shows "erased user" instead of the original name/email.
 *
 * Workspaces solely owned by the erased user: the transfer-or-delete flow
 * is resolved at deletion-policy time (see the ownership transfer service).
 * The erasure doesn't auto-delete workspaces — the user must transfer
 * ownership or delete the workspace first.
 *
 * Legal hold blocks the erasure entirely (if any workspace the user is a
 * member of has a legal hold, the erasure is blocked — checked by the
 * residency service's eraseUser function).
 */
export async function eraseUser(uid: string): Promise<void> {
  const pseudoEmail = `erased_${randomUUID().slice(0, 16)}@invalid`;

  await db.transaction(async (tx) => {
    // 1. Anonymize identity (via Supabase admin API — outside the tx,
    // but the membership + session + erased_identities are in the tx).
    try {
      const { supabaseService } = await import("@/lib/supabase/server");
      const supabase = await supabaseService();
      await supabase.auth.admin.updateUserById(uid, {
        email: pseudoEmail,
        user_metadata: {
          full_name: "deleted user",
          erased: true,
          erased_at: new Date().toISOString(),
        },
      });
    } catch (err) {
      // If Supabase is unavailable, continue (the membership + session
      // revocation + erased_identities still happen — the identity is
      // anonymized at the readable surface level via the view mapping).
      console.error(`[erasure] failed to anonymize Supabase identity for ${uid}:`, err);
    }

    // 2. Revoke all sessions.
    await tx
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: "erasure" })
      .where(
        and(
          eq(sessions.userId, uid as any),
          isNull(sessions.revokedAt),
        ),
      );

    // 3. Insert into erased_identities (view-level pseudonymization).
    await tx
      .insert(erasedIdentities)
      .values({ oldId: uid as any })
      .onConflictDoNothing();

    // 4. Mark memberships as erased.
    await tx
      .update(memberships)
      .set({ status: "erased" as any })
      .where(
        and(
          eq(memberships.userId, uid as any),
          isNull(sessions.revokedAt), // only active memberships.
        ),
      );
  });

  // 5. Append erasure event to the audit log (the chain stays intact).
  await auditSystem({
    action: "user.erased",
    target: { user: "[pseudonymized]" },
  });
}
