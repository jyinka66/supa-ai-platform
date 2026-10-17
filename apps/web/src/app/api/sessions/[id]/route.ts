import { NextRequest } from "next/server";
import { supabaseService } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/session";
import { problem, ok } from "@/lib/api/problem";

/**
 * DELETE /api/sessions/:id
 *
 * Revokes a single session row. RLS already restricts DELETE to the
 * user themselves, but we re-check ownership here so a missing row
 * returns 404 instead of a silent no-op.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  const { id: sessionId } = await params;

  const admin = supabaseService();

  // Verify ownership first.
  const { data: session, error: fetchErr } = await admin
    .from("user_sessions")
    .select("id, user_id")
    .eq("id", sessionId)
    .maybeSingle();
  if (fetchErr) return problem(500, "fetch_failed");
  if (!session) return problem(404, "session_not_found");
  if (session.user_id !== user.id) return problem(403, "forbidden");

  const { error } = await admin
    .from("user_sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", sessionId)
    .is("revoked_at", null);
  if (error) return problem(500, "revoke_failed");

  return ok({ id: sessionId, revoked: true });
}
