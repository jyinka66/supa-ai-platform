import { NextRequest } from "next/server";
import { z } from "zod";
import { supabaseService } from "@/lib/supabase/server";
import { requireUser, assertRole } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { problem, ok } from "@/lib/api/problem";
import { ip } from "@/lib/utils/ip";
import { generateInviteToken, sha256 } from "@/lib/auth/tokens";
import { sendInviteEmail } from "@/lib/email/send";
import { seatsFull, getWorkspaceName } from "@/lib/workspaces/queries";
import type { WorkspaceRole } from "@/lib/workspaces/queries";

const Body = z.object({
  workspaceId: z.string().uuid(),
  email: z.string().email().max(254),
  role: z.enum(["admin", "member", "viewer"]).default("member"),
});

/**
 * POST /api/invites
 *
 * Issues a single-use workspace invite token.
 *
 * Token design (defense in depth):
 *   - Raw token format: <uuid>.<uuid>.<hmac(workspaceId|email, secret)>
 *   - DB stores sha256(rawToken) — raw never persisted
 *   - Email link contains raw token — only the recipient can use it
 *   - HMAC binds the token to (workspaceId, email) — can't be reused for other pairs
 *   - Single-use: status='pending' guard on accept
 *   - 7-day expiry
 *
 * Rate-limited per IP at 10/10min.
 */
export async function POST(req: NextRequest) {
  const actor = await requireUser();

  // Rate limit BEFORE parsing body — attackers shouldn't burn our DB CPU.
  const rl = await checkRateLimit("inviteAccept", ip(req));
  if (!rl.ok) {
    return problem(429, "rate_limited", undefined, { retryAfter: rl.retryAfter });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return problem(400, "invalid_json");
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return problem(400, "invalid_request", parsed.error.issues[0]?.message);
  }

  const { workspaceId, email, role } = parsed.data;

  // Permission check — only owner/admin can invite.
  const allowed = await assertRole(actor.id, workspaceId, ["owner", "admin"]);
  if (!allowed) return problem(403, "forbidden");

  // Seat limit check — fails fast before generating tokens.
  if (await seatsFull(workspaceId)) {
    return problem(409, "seats_full");
  }

  // Generate the signed token + hash.
  const rawToken = generateInviteToken(workspaceId, email.toLowerCase());
  const tokenHash = await sha256(rawToken);

  const admin = supabaseService();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const { error } = await admin.from("invites").insert({
    workspace_id: workspaceId,
    email: email.toLowerCase(),
    role: role as WorkspaceRole,
    token_hash: tokenHash,
    invited_by: actor.id,
    status: "pending",
    expires_at: expiresAt,
    resend_count: 0,
  });

  if (error) {
    if (error.code === "23505") return problem(409, "invite_exists");
    return problem(500, "invite_create_failed");
  }

  // Fetch workspace + actor profile for email rendering.
  // (Avoid blocking the response on email send failure — best-effort delivery.)
  const workspaceName = await getWorkspaceName(workspaceId).catch(() => "a workspace");
  const actorName = (actor.email ?? "Someone").split("@")[0]!;

  // Fire-and-await — if this throws, we still return 201 so the client
  // knows the invite was created; the user can resend via the UI.
  sendInviteEmail(email.toLowerCase(), workspaceName, actorName, rawToken).catch((err) => {
    console.warn(
      JSON.stringify({
        event: "invite_email_send_failed",
        workspace_id: workspaceId,
        email: "present",
        error: String(err),
      }),
    );
  });

  return ok({ workspaceId, email: email.toLowerCase(), role, expiresAt }, 201);
}
