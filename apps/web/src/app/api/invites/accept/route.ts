import { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { problem, ok } from "@/lib/api/problem";
import { ip } from "@/lib/utils/ip";
import {
  findInviteByHash,
  isInviteValid,
  acceptInvite,
  inviteTokenMatches,
} from "@/lib/invites/queries";

const Body = z.object({
  token: z.string().min(1).max(512),
});

/**
 * POST /api/invites/accept
 *
 * Accepts a workspace invite token.
 *
 * Flow:
 *   1. Rate-limit by IP (10/10min).
 *   2. Hash the raw token, look up the invite row.
 *   3. Validate status='pending' AND not expired.
 *   4. Verify the HMAC inside the token matches (workspaceId, email) —
 *      catches tampering where an attacker substitutes a different email.
 *   5. Compare invite.email against caller's auth email — they must match.
 *   6. Atomically flip invite status='accepted' AND insert the membership row.
 *
 * Single-use guarantee: the UPDATE … WHERE status='pending' clause is the
 * race-condition shield. If two requests race, only one will see a non-null
 * returning row; the other gets invite_already_consumed.
 *
 * Auth: the caller must be signed in (requireUser). We don't auto-create
 * accounts — the invite email link directs unauthenticated users to sign
 * up first, then accept.
 */
export async function POST(req: NextRequest) {
  const user = await requireUser();

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

  const invite = await findInviteByHash(parsed.data.token);
  if (!invite || !isInviteValid(invite)) {
    return problem(410, "invite_invalid");
  }

  // The caller's auth email must match the invite's intended recipient.
  if (invite.email !== (user.email ?? "").toLowerCase()) {
    return problem(403, "invite_email_mismatch");
  }

  // HMAC verification — catches tampered tokens even if the row was found.
  if (!inviteTokenMatches(parsed.data.token, invite.workspace_id, invite.email)) {
    return problem(410, "invite_invalid");
  }

  try {
    const result = await acceptInvite(invite, user.id);
    return ok(result);
  } catch (err) {
    if ((err as Error).message === "invite_already_consumed") {
      return problem(410, "invite_consumed");
    }
    console.warn(
      JSON.stringify({
        event: "invite_accept_failed",
        invite_id: invite.id,
        error: String(err),
      }),
    );
    return problem(500, "accept_failed");
  }
}
