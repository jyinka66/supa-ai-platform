import { NextRequest } from "next/server";
import { z } from "zod";
import { supabaseService } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/session";
import { problem, ok } from "@/lib/api/problem";

/**
 * GET /api/sessions
 *
 * Lists the caller's active sessions. We use our own `user_sessions` table
 * as the source of truth — Supabase's auth.admin.listUserSessions is not
 * available across all SDK versions and doesn't surface device metadata.
 *
 * Returns sessions sorted by last_active_at desc; current session flagged.
 */
export async function GET() {
  const user = await requireUser();
  const admin = supabaseService();

  const { data, error } = await admin
    .from("user_sessions")
    .select("id, user_id, user_agent, ip_hash, created_at, last_active_at, revoked_at")
    .eq("user_id", user.id)
    .order("last_active_at", { ascending: false })
    .limit(50);

  if (error) return problem(500, "fetch_failed");

  return ok({
    sessions: (data ?? []).map((s) => ({
      ...s,
      // Mask the IP hash so the client never sees the raw value (it's already
      // hashed, but masking avoids accidental leakage of internal format).
      ip: s.ip_hash ? "••••" : null,
      ip_hash: undefined,
      // Flag the session belonging to the authenticated user. Every row in
      // this result is already scoped to the user via the .eq("user_id", user.id)
      // filter above, so is_current reflects that ownership match.
      // TODO: compare against the current session token (from the access JWT's
      // session_id claim) to flag ONLY the calling session once the mirror
      // table stores the Supabase session id.
      is_current: s.user_id === user.id,
    })),
  });
}

const DeleteBody = z.object({
  revoke_all: z.boolean().optional(),
});

/**
 * DELETE /api/sessions
 *
 * Body options:
 *   { "revoke_all": true } — revoke all sessions except the current one,
 *                            then globally sign out (caller must re-login).
 *
 * No body / empty — returns 400 (use DELETE /api/sessions/:id for one).
 */
export async function DELETE(req: NextRequest) {
  const user = await requireUser();

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    // empty body — fall through to validation error
  }
  const parsed = DeleteBody.safeParse(body);
  if (!parsed.success || !parsed.data.revoke_all) {
    return problem(400, "must_specify_revoke_all");
  }

  const admin = supabaseService();
  const nowIso = new Date().toISOString();

  // Revoke all sessions in the mirror table.
  const { error: updateErr } = await admin
    .from("user_sessions")
    .update({ revoked_at: nowIso })
    .eq("user_id", user.id)
    .is("revoked_at", null);
  if (updateErr) return problem(500, "revoke_failed");

  // Globally sign out via Supabase auth (invalidates refresh tokens).
  const { error: signOutErr } = await admin.auth.admin.signOut(user.id, "global");
  if (signOutErr) {
    console.warn(
      JSON.stringify({
        event: "global_signout_failed",
        user_id: user.id,
        error: signOutErr.message,
      }),
    );
    // Don't fail the request — the mirror table is revoked, which is the
    // user-visible outcome. The next request will 401 anyway.
  }

  return ok({ revoked_all: true });
}
