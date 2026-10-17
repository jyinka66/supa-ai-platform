import { NextRequest } from "next/server";
import { z } from "zod";
import { supabaseService } from "@/lib/supabase/server";
import { requireUser, rotateSessions } from "@/lib/auth/session";
import { guard } from "@/lib/ratelimit/guard";
import { problem, ok } from "@/lib/api/problem";
import { AUTH_CONFIG } from "@/lib/auth/config";

const POST_REASONS = ["user_request", "gdpr"] as const;
const PostBody = z.object({
  reason: z.enum(POST_REASONS).default("user_request"),
});

/**
 * POST /api/account/deletion
 *
 * Schedules an account deletion request. The user remains signed in but
 * cannot perform privileged actions; a 30-day grace period starts during
 * which they can cancel.
 *
 * Side effects:
 *   - Insert row in `deletion_requests` with purgeAt = now + 30d
 *   - Set profiles.deletion_requested_at = now (so UI shows banner)
 *   - Globally sign out (forces re-auth, blocks future requests)
 *   - Email confirmation to user
 *
 * Idempotent: if a request already exists, returns 200 with the existing purgeAt.
 */
export async function POST(req: NextRequest) {
  const denied = await guard(req, "authActions");
  if (denied) return denied;

  const user = await requireUser();

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    // empty body is allowed — defaults apply
  }
  const parsed = PostBody.safeParse(body);
  if (!parsed.success) {
    return problem(400, "invalid_request", parsed.error.issues[0]?.message);
  }

  const admin = supabaseService();
  const purgeAt = new Date(Date.now() + AUTH_CONFIG.deletionGraceDays * 24 * 60 * 60 * 1000);

  // Upsert the deletion request — idempotent.
  const { data: existing } = await admin
    .from("deletion_requests")
    .select("purge_at, cancelled_at")
    .eq("user_id", user.id)
    .maybeSingle();

  if (existing && !existing.cancelled_at) {
    // Already requested — return existing.
    return ok({ purgeAt: existing.purge_at, status: "pending" });
  }

  const { error: upsertErr } = await admin
    .from("deletion_requests")
    .upsert(
      {
        user_id: user.id,
        requested_at: new Date().toISOString(),
        purge_at: purgeAt.toISOString(),
        cancelled_at: null,
      },
      { onConflict: "user_id" },
    );
  if (upsertErr) return problem(500, "deletion_request_failed");

  // Stamp the profile so the UI can show the deletion banner.
  const { error: profileErr } = await admin
    .from("profiles")
    .update({ deletion_requested_at: new Date().toISOString() })
    .eq("id", user.id);
  if (profileErr) {
    console.warn(
      JSON.stringify({ event: "deletion_profile_stamp_failed", user_id: user.id }),
    );
    // Don't fail the request — the deletion_request row is the source of truth.
  }

  // Send confirmation email (best-effort).
  // TODO: wire into email provider (Resend/SendGrid) when ready. Until then,
  // surface a console.warn so the missing confirmation is visible — the
  // user requested deletion and they should receive a confirmation email,
  // but no email provider is configured on this deployment.
  console.warn(
    JSON.stringify({
      event: "deletion_confirmation_email_not_sent",
      reason: "email_provider_not_wired",
      user_id: user.id,
      purge_at: purgeAt.toISOString(),
    }),
  );
  console.info(
    JSON.stringify({
      event: "deletion_requested",
      user_id: user.id,
      purge_at: purgeAt.toISOString(),
    }),
  );

  // Globally sign out — forces fresh auth, blocks privileged surfaces.
  await rotateSessions(user.id).catch((err) => {
    console.warn(
      JSON.stringify({
        event: "rotate_sessions_failed",
        user_id: user.id,
        error: String(err),
      }),
    );
  });

  return ok({ purgeAt: purgeAt.toISOString(), status: "pending" }, 201);
}

/**
 * DELETE /api/account/deletion
 *
 * Cancels a pending deletion request. The user can log back in immediately.
 *
 * If no pending request exists, returns 404.
 * If the purgeAt has already passed, returns 410 — too late, account is gone.
 */
export async function DELETE(req: NextRequest) {
  const denied = await guard(req, "authActions");
  if (denied) return denied;

  const user = await requireUser();
  const admin = supabaseService();

  const { data: existing, error: fetchErr } = await admin
    .from("deletion_requests")
    .select("purge_at, cancelled_at")
    .eq("user_id", user.id)
    .maybeSingle();
  if (fetchErr) return problem(500, "fetch_failed");
  if (!existing) return problem(404, "no_pending_request");

  // Past purgeAt → too late.
  if (new Date(existing.purge_at) < new Date()) {
    return problem(410, "purge_already_completed");
  }
  // Already cancelled.
  if (existing.cancelled_at) {
    return ok({ status: "already_cancelled" });
  }

  const { error: updateErr } = await admin
    .from("deletion_requests")
    .update({ cancelled_at: new Date().toISOString() })
    .eq("user_id", user.id)
    .is("cancelled_at", null);
  if (updateErr) return problem(500, "cancel_failed");

  // Clear the profile timestamp too.
  await admin
    .from("profiles")
    .update({ deletion_requested_at: null })
    .eq("id", user.id);

  return ok({ status: "cancelled" });
}
