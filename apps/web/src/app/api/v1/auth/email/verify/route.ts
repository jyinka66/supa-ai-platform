// POST /api/v1/auth/email/verify — verify email with token.
//
// The token is from the email verification link (sent by Supabase on signup).
// The token is single-use + expires in 24h.
// On success: `email_verified_at` is set on the user record.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { errorResponse, requestId, jsonLimiter, corsHeaders } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VerifyBody = z.object({
  token: z.string().min(1),
  type: z.enum(["signup", "email"]).default("signup"),
});

export async function POST(req: NextRequest) {
  const rid = requestId(req);
  try {
    jsonLimiter(req);
    const body = await req.json();
    const parsed = VerifyBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }

    const { token, type } = parsed.data;

    // Verify the email token via Supabase.
    const supabase = await supabaseServer();
    const { data, error } = await supabase.auth.verifyOtp({
      token_hash: token,
      type: type as any,
    });

    if (error || !data.user) {
      return NextResponse.json({ error: "invalid_or_expired_token" }, { status: 400 });
    }

    // The user's email is now verified (Supabase sets email_confirmed_at).
    const res = NextResponse.json(
      {
        message: "Email verified successfully.",
        user_id: data.user.id,
      },
      { status: 200 },
    );
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/v1/auth/email/verify");
  }
}
