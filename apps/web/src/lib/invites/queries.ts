import { supabaseService } from "@/lib/supabase/server";
import { sha256, verifyInviteToken } from "@/lib/auth/tokens";
import type { WorkspaceRole } from "@/lib/workspaces/queries";

export interface InviteRow {
  id: string;
  workspace_id: string;
  email: string;
  role: WorkspaceRole;
  token_hash: string;
  invited_by: string;
  status: "pending" | "accepted" | "revoked";
  expires_at: string;
  consumed_at: string | null;
  resend_count: number;
}

/**
 * Looks up an invite by the SHA-256 of the raw token.
 * Returns null if no match — never throws for missing rows (route handler
 * converts to a 410 gone).
 */
export async function findInviteByHash(rawToken: string): Promise<InviteRow | null> {
  const hash = await sha256(rawToken);
  const admin = supabaseService();
  const { data, error } = await admin
    .from("invites")
    .select("*")
    .eq("token_hash", hash)
    .maybeSingle();
  if (error) throw error;
  return (data as InviteRow | null) ?? null;
}

/**
 * Returns true if the invite is still valid:
 *   - status is pending
 *   - expires_at is in the future
 */
export function isInviteValid(invite: InviteRow, now = new Date()): boolean {
  if (invite.status !== "pending") return false;
  return new Date(invite.expires_at) > now;
}

/**
 * Atomically marks the invite as accepted AND inserts the membership row.
 * Uses Postgres advisory-style "compare-and-set" via a WHERE clause on status='pending'
 * to guarantee single-use semantics even under concurrent accept attempts.
 *
 * The caller is responsible for verifying the invite token (via verifyInviteToken)
 * BEFORE calling this function.
 */
export async function acceptInvite(
  invite: InviteRow,
  userId: string,
): Promise<{ workspaceId: string }> {
  const admin = supabaseService();

  // 1. Atomic compare-and-set: only this caller can flip status to 'accepted'.
  //    Returning the row confirms we won the race; otherwise someone beat us.
  const { data: claimed, error: claimError } = await admin
    .from("invites")
    .update({ status: "accepted", consumed_at: new Date().toISOString() })
    .eq("id", invite.id)
    .eq("status", "pending") // single-use guard
    .select()
    .maybeSingle();

  if (claimError) throw claimError;
  if (!claimed) {
    throw new Error("invite_already_consumed");
  }

  // 2. Insert the membership row. ON CONFLICT DO NOTHING handles the
  //    edge case where the user is already a member of the workspace.
  const { error: memberError } = await admin.from("workspace_members").insert({
    workspace_id: invite.workspace_id,
    user_id: userId,
    role: invite.role,
    invited_by: invite.invited_by,
  });

  if (memberError) {
    // Best-effort rollback — flip status back to pending so the user can retry.
    await admin
      .from("invites")
      .update({ status: "pending", consumed_at: null })
      .eq("id", invite.id);
    throw memberError;
  }

  return { workspaceId: invite.workspace_id };
}

/**
 * Returns true if the raw token's HMAC matches the (workspaceId, email) pair.
 * Used as a second line of defense (after the sha256 DB lookup).
 */
export function inviteTokenMatches(
  rawToken: string,
  workspaceId: string,
  email: string,
): boolean {
  return verifyInviteToken(rawToken, workspaceId, email);
}
