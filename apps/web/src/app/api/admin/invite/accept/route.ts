import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { acceptAdminInvite } from "@/lib/admin/invite";
import { requireUser } from "@/lib/auth/session";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";

/**
 * POST /api/admin/invite/accept
 *
 * Accept an admin invite. Verifies the token (HMAC + 48h expiry) + creates
 * the admin_users row in INVITED state (mfa_enrolled=false).
 *
 * Auth: PRODUCT session (not admin session — the recipient hasn't been
 * onboarded as an admin yet). This is the bootstrap path.
 *
 * Body:
 *   { "token": "<single-use-token>" }
 *
 * Response 200:
 *   { "role": "standard", "next": "enroll_mfa" }
 *
 * After accepting, the recipient must:
 *   1. POST /api/admin/mfa/enroll — generate the TOTP secret + QR.
 *   2. POST /api/admin/mfa/confirm — verify the TOTP code, mark enrolled.
 *   3. POST /api/admin/login — product auth + admin MFA step-up → admin session.
 *
 * Response 400: invalid/expired token (no oracle — uniform "invalid_token").
 * Response 409: user is already an admin.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AcceptBody = z.object({
  token: z.string().min(1),
});

export async function POST(req: NextRequest) {
  const rid = requestId(req);
  try {
    // Product auth (not admin session — bootstrap).
    const user = await requireUser();
    const uid = user.id;

    const body = await req.json();
    const parsed = AcceptBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_request", detail: parsed.error.message },
        { status: 400 },
      );
    }

    const result = await acceptAdminInvite(parsed.data.token, uid);

    const res = NextResponse.json(
      { role: result.role, next: "enroll_mfa" },
      { status: 200 },
    );
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/api/admin/invite/accept");
  }
}
