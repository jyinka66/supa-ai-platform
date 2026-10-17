import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminSession } from "@/lib/admin/middleware";
import { inviteAdmin } from "@/lib/admin/invite";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";

/**
 * POST /api/admin/invite
 *
 * Invite a new admin (owner-only). Creates a single-use invite token
 * (HMAC-signed, 48h expiry) carrying (email, role). The token is returned
 * in the response — the caller is responsible for emailing it to the recipient.
 *
 * Auth: admin session with minRole="owner" (only owners can invite).
 *
 * Body:
 *   {
 *     "email": "new-admin@example.com",
 *     "role": "standard"   // owner | senior | standard | support | read_only
 *   }
 *
 * Response 200:
 *   {
 *     "token": "<single-use-token>",
 *     "email": "new-admin@example.com",
 *     "role": "standard",
 *     "expiresAt": "2026-10-08T..."
 *   }
 *
 * The recipient uses POST /api/admin/invite/accept with their product session
 * to create the admin_users row, then enrolls MFA.
 *
 * NO SELF-SERVICE ESCALATION: only owners can invite. A senior admin cannot.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const InviteBody = z.object({
  email: z.string().email(),
  role: z.enum(["owner", "senior", "standard", "support", "read_only"]),
});

export async function POST(req: NextRequest) {
  const rid = requestId(req);
  try {
    // Owner-only — requireAdminSession throws AdminAuthError(403) if insufficient.
    const ctx = await requireAdminSession(req, "owner");

    const body = await req.json();
    const parsed = InviteBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_request", detail: parsed.error.message },
        { status: 400 },
      );
    }

    const result = await inviteAdmin(
      { adminId: ctx.adminId, role: ctx.role, sessionId: ctx.sessionId, ip: ctx.ip },
      parsed.data.email,
      parsed.data.role,
    );

    const res = NextResponse.json(
      {
        token: result.token,
        email: result.email,
        role: result.role,
        expiresAt: result.expiresAt.toISOString(),
      },
      { status: 200 },
    );
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/api/admin/invite");
  }
}
