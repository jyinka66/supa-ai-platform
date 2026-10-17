// POST /api/v1/auth/password/reset — reset password with token.
//
// Flow:
//   1. Validate body (token + new password).
//   2. Check password policy.
//   3. Verify the reset token via Supabase (the token is in the email link
//      — Supabase verifies it).
//   4. Set the new password.
//   5. Revoke ALL sessions for the user (security: a password reset means
//      the old password may have been compromised → log out everywhere).
//   6. Audit the reset.
//
// The token is single-use (Supabase enforces this). If the token is expired
// (1h) or already used, Supabase returns an error → 400.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { requirePwPolicy } from "@/lib/auth/passwords";
import { revokeAllSessions } from "@/lib/auth/session";
import { errorResponse, requestId, jsonLimiter, corsHeaders } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ResetBody = z.object({
  token: z.string().min(1),
  type: z.enum(["recovery", "signup"]).default("recovery"),
  password: z.string().min(1),
});

export async function POST(req: NextRequest) {
  const rid = requestId(req);
  try {
    jsonLimiter(req);
    const body = await req.json();
    const parsed = ResetBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }

    const { token, type, password } = parsed.data;

    // Validate password policy.
    try {
      requirePwPolicy(password);
    } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }

    // Verify the token + set the new password via Supabase.
    const supabase = await supabaseServer();
    const { data, error } = await supabase.auth.verifyOtp({
      token_hash: token,
      type: type as any,
    });

    if (error || !data.user) {
      return NextResponse.json({ error: "invalid_or_expired_token" }, { status: 400 });
    }

    const uid = data.user.id;

    // Update the password.
    const { error: updateError } = await supabase.auth.admin.updateUserById(uid, {
      password,
    });

    if (updateError) {
      return NextResponse.json({ error: "password_update_failed" }, { status: 500 });
    }

    // Revoke ALL sessions (security: old password may be compromised).
    await revokeAllSessions(uid);

    // Audit (best-effort).
    try {
      const { db } = await import("@supa/db");
      const { sql } = await import("drizzle-orm");
      await db.execute(sql`
        select enterprise_audit_log_append(
          null::uuid, 'user', ${uid}, 'auth.password_reset',
          '{}'::jsonb, null::inet, null::text
        )
      `);
    } catch {}

    const res = NextResponse.json(
      { message: "Password reset. Please log in with your new password." },
      { status: 200 },
    );
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/v1/auth/password/reset");
  }
}
