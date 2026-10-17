import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminSession } from "@/lib/admin/middleware";
import { enrollAdminMfa } from "@/lib/admin/mfa";
import { getAdminUser } from "@/lib/admin/auth";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";

/**
 * POST /api/admin/mfa/enroll
 *
 * Generate a TOTP secret for the current admin (for display as a QR code).
 * The secret is KMS-encrypted + stored on admin_users.mfa_secret (mfa_enrolled
 * stays false until /mfa/confirm is called with a valid code).
 *
 * This route is used by an admin who has ALREADY authenticated (via the
 * invite flow: a senior admin creates the admin_users row, the invitee logs
 * in via /api/admin/login which requires MFA — chicken-and-egg). So the actual
 * flow for a NEW admin is:
 *
 *   1. Senior admin invites user (POST /api/admin/invite — not yet wired,
 *      uses lib/admin/invite.ts inviteAdmin).
 *   2. The invitee can't log in yet (no MFA enrolled → /api/admin/login 401).
 *   3. The invitee authenticates via PRODUCT auth (their normal session),
 *      then calls this route with their product session to enroll admin MFA.
 *   4. They confirm via /api/admin/mfa/confirm (also product-session authed).
 *   5. Now they can /api/admin/login (product auth + admin MFA step-up).
 *
 * For this bootstrap case, this route accepts EITHER an admin session OR a
 * product session (the latter only for admins who haven't enrolled MFA yet).
 * The product-session path is gated by the admin_users row existing (the user
 * must have been invited) + accepted_at IS NULL (they haven't confirmed yet).
 *
 * Auth: admin session OR product session (for the bootstrap case).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EnrollBody = z.object({
  email: z.string().email().optional(), // for the otpauth label.
});

export async function POST(req: NextRequest) {
  const rid = requestId(req);
  try {
    const body = await req.json().catch(() => ({}));
    const parsed = EnrollBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_request", detail: parsed.error.message },
        { status: 400 },
      );
    }

    // Try admin session first.
    let uid: string;
    try {
      const ctx = await requireAdminSession(req);
      uid = ctx.adminId;
    } catch {
      // Fall back to product session (bootstrap case — admin invitee who
      // hasn't enrolled MFA yet).
      const { requireUser } = await import("@/lib/auth/session");
      const user = await requireUser();
      uid = user.id;

      // Verify the user has an admin_users row (was invited) + hasn't accepted yet.
      const admin = await getAdminUser(uid);
      if (!admin) {
        return NextResponse.json({ error: "not_invited" }, { status: 403 });
      }
      if (admin.revokedAt) {
        return NextResponse.json({ error: "admin_revoked" }, { status: 403 });
      }
      if (admin.mfaEnrolled) {
        return NextResponse.json({ error: "already_enrolled" }, { status: 409 });
      }
    }

    const email = parsed.data.email ?? "admin@example.com";
    const result = await enrollAdminMfa(uid, email);

    const res = NextResponse.json(
      { otpauthUrl: result.otpauthUrl, secret: result.secret },
      { status: 200 },
    );
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/api/admin/mfa/enroll");
  }
}
