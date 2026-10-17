import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminSession } from "@/lib/admin/middleware";
import { confirmAdminMfa } from "@/lib/admin/mfa";
import { getAdminUser } from "@/lib/admin/auth";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";

/**
 * POST /api/admin/mfa/confirm
 *
 * Confirm MFA enrollment — verify the TOTP code, mark mfa_enrolled=true,
 * accept the invite (set accepted_at). Returns 200 on success.
 *
 * Same auth as /mfa/enroll: admin session OR product session (bootstrap case
 * for invitees who haven't confirmed yet).
 *
 * Body: { "code": "123456" }
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ConfirmBody = z.object({
  code: z.string().regex(/^\d{6}$/, "code must be 6 digits"),
});

export async function POST(req: NextRequest) {
  const rid = requestId(req);
  try {
    const body = await req.json();
    const parsed = ConfirmBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_request", detail: parsed.error.message },
        { status: 400 },
      );
    }

    // Auth: admin session OR product session (bootstrap).
    let uid: string;
    try {
      const ctx = await requireAdminSession(req);
      uid = ctx.adminId;
    } catch {
      const { requireUser } = await import("@/lib/auth/session");
      const user = await requireUser();
      uid = user.id;

      const admin = await getAdminUser(uid);
      if (!admin || admin.revokedAt) {
        return NextResponse.json({ error: "not_invited" }, { status: 403 });
      }
      if (admin.mfaEnrolled) {
        return NextResponse.json({ error: "already_enrolled" }, { status: 409 });
      }
    }

    const ok = await confirmAdminMfa(uid, parsed.data.code);
    if (!ok) {
      // No oracle — the code is wrong, the admin is revoked, or MFA isn't
      // enrolled. Uniform 401.
      return NextResponse.json({ error: "invalid_code" }, { status: 401 });
    }

    const res = NextResponse.json({ ok: true, enrolled: true }, { status: 200 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/api/admin/mfa/confirm");
  }
}
