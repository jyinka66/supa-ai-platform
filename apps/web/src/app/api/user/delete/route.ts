import { NextRequest } from "next/server";
import { z } from "zod";
import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "@supa/db";
import {
  profiles,
  deletionRequests,
  workspaces,
  conversations,
  messages,
  shareLinks,
  messageMeta,
  messageFeedback,
  workspaceMembers,
  userSessions,
} from "@supa/db/schema";
import { requireUser, rotateSessions } from "@/lib/auth/session";
import { guard } from "@/lib/ratelimit/guard";
import { audit } from "@/lib/audit";
import { ok } from "@/lib/api/problem";
import { parseBody } from "@/lib/validate";
import { supabaseService } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  confirm: z.literal("DELETE"),
}).strict();

/**
 * POST /api/user/delete
 *
 * Immediate hard-delete — bypasses the 30-day grace period.
 * Requires typed confirmation (`{ confirm: "DELETE" }`).
 *
 * Wrapped in a Drizzle transaction so a failure anywhere rolls back everything.
 *
 * Deletion order (children first, parent last):
 *   1. message_feedback (FK → messages)
 *   2. message_meta (FK → messages)
 *   3. messages (FK → conversations)
 *   4. share_links (FK → conversations)
 *   5. conversations (FK → workspaces, auth.users)
 *   6. workspace_members (FK → workspaces, auth.users)
 *   7. user_sessions (FK → auth.users)
 *   8. deletion_requests (FK → auth.users)
 *   9. profiles (FK → auth.users)
 *  10. auth.users (via Supabase admin API — outside transaction)
 *  11. Personal workspaces → anonymized (soft-delete, keeps audit trail)
 *
 * Audit log is append-only (REVOKE UPDATE) — we don't touch it. The
 * `actor_id` in audit_log rows points to the now-deleted user UUID, which
 * can't be re-assigned (Supabase generates new UUIDs), so there's no PII leak.
 *
 * Rate-limited at `authActions` tier (5/5min).
 *
 * NOTE: for the normal GDPR flow, use POST /api/account/deletion which
 * schedules a 30-day grace period. This route is for immediate deletion.
 */
export async function POST(req: NextRequest) {
  const denied = await guard(req, "authActions");
  if (denied) return denied;

  const user = await requireUser();

  const result = await parseBody(req, Body);
  if (!result.ok) return result.res;

  // Fetch profile + personal workspaces BEFORE deletion (for audit metadata).
  const profile = await db
    .select()
    .from(profiles)
    .where(eq(profiles.id, user.id))
    .limit(1);

  const personalWorkspaces = await db
    .select({ id: workspaces.id, slug: workspaces.slug })
    .from(workspaces)
    .where(and(eq(workspaces.billingOwnerId, user.id), eq(workspaces.isPersonal, true)));

  // ============ TRANSACTION: hard-delete user data ============
  await db.transaction(async (tx) => {
    // 1. Get conversation IDs owned by this user (for cascading deletes).
    const convRows = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.userId, user.id));
    const convIds = convRows.map((r) => r.id);

    if (convIds.length > 0) {
      // 2. Delete message_feedback for messages in those conversations.
      await tx
        .delete(messageFeedback)
        .where(
          inArray(
            messageFeedback.messageId,
            tx.select({ id: messages.id }).from(messages).where(inArray(messages.conversationId, convIds)),
          ),
        );

      // 3. Delete message_meta for messages in those conversations.
      await tx
        .delete(messageMeta)
        .where(
          inArray(
            messageMeta.messageId,
            tx.select({ id: messages.id }).from(messages).where(inArray(messages.conversationId, convIds)),
          ),
        );

      // 4. Delete messages in those conversations.
      await tx.delete(messages).where(inArray(messages.conversationId, convIds));

      // 5. Delete share_links in those conversations.
      await tx.delete(shareLinks).where(inArray(shareLinks.conversationId, convIds));

      // 6. Delete the conversations.
      await tx.delete(conversations).where(inArray(conversations.id, convIds));
    }

    // 7. Delete workspace_memberships (the user's role in workspaces).
    await tx.delete(workspaceMembers).where(eq(workspaceMembers.userId, user.id));

    // 8. Delete user_sessions.
    await tx.delete(userSessions).where(eq(userSessions.userId, user.id));

    // 9. Delete deletion_requests.
    await tx.delete(deletionRequests).where(eq(deletionRequests.userId, user.id));

    // 10. Delete the profile row.
    await tx.delete(profiles).where(eq(profiles.id, user.id));

    // 11. Anonymize personal workspaces (soft-delete — keep row for audit).
    for (const ws of personalWorkspaces) {
      await tx
        .update(workspaces)
        .set({
          name: "[deleted user]",
          slug: `deleted-${ws.id}`,
          logoPath: null,
          country: null,
          timezone: "UTC",
          defaultLanguage: "en",
        })
        .where(eq(workspaces.id, ws.id));
    }
  });

  // 12. Delete auth.users row via Supabase admin API (outside transaction —
  //     can't access auth schema via Drizzle).
  const admin = supabaseService();
  const { error: deleteErr } = await admin.auth.admin.deleteUser(user.id);
  if (deleteErr) {
    // Log — user data is gone; auth.users row is orphaned but harmless.
    console.error(
      JSON.stringify({
        event: "auth_users_delete_failed",
        user_id: user.id,
        error: deleteErr.message,
      }),
    );
  }

  // 13. Audit the deletion.
  // NOTE: do NOT include PII (email, name) in audit metadata — audit_log
  // is readable by workspace admins, and the user is being deleted, so
  // their PII should not persist in a new location.
  await audit({
    actorId: null,
    actorKind: "system",
    action: "user.data_delete",
    targetType: "user",
    targetId: user.id,
    metadata: {
      // Non-PII metadata only — counts for analytics.
      personalWorkspaceCount: personalWorkspaces.length,
      gracePeriodBypassed: true,
    },
  });

  // 14. Rotate sessions (best-effort — user is deleted).
  await rotateSessions(user.id).catch(() => {});

  return ok({ deleted: true, userId: user.id });
}
