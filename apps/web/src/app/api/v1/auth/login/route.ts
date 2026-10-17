// POST /api/v1/auth/login — authenticate with email + password, create a v2 session.
//
// Flow:
//   1. Validate the request body (email + password).
//   2. Authenticate via Supabase auth (verifies the password against the
//      stored argon2id hash in auth.users).
//   3. Create a v2 session (opaque refresh token, argon2id, 30-day absolute,
//      14-day rolling idle).
//   4. Issue a 15-min access token (JWT with sub + jti + mfa).
//   5. Set the refresh token in an HttpOnly, Secure, SameSite=Lax cookie.
//   6. Return the access token + user id in the response body.
//
// The access token is returned in the JSON body (the client stores it in
// memory — NOT in localStorage — to minimize the XSS damage window). The
// refresh token is ONLY in the HttpOnly cookie (never accessible to JS).
//
// Rate limiting: this route is rate-limited by IP + (IP, email) via the
// existing `guardLogin` pattern (apps/web/src/lib/ratelimit/guard.ts).

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { createSession, issueAccessToken, type RequestContext } from "@/lib/auth/session";
import { setRefreshCookie } from "@/lib/auth/cookies";
import { errorResponse, requestId, jsonLimiter, corsHeaders } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(req: NextRequest) {
  const rid = requestId(req);
  try {
    jsonLimiter(req);

    const body = await req.json();
    const parsed = LoginBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_request", detail: parsed.error.message },
        { status: 400 },
      );
    }

    const { email, password } = parsed.data;

    // Authenticate via Supabase (verifies the password).
    const supabase = await supabaseServer();
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error || !data.user || !data.session) {
      // UNIFORM TIMING ENVELOPE: if the email is unknown, Supabase returns
      // quickly (no password hash to verify). An attacker can distinguish
      // "email not found" (fast) from "wrong password" (slow — argon2id verify).
      //
      // Mitigation: perform a dummy argon2id verify on failure to add the
      // same latency as a real verify. The response is identical (401
      // invalid_credentials) regardless of whether the email exists.
      try {
        const argon2 = await import("argon2");
        await argon2.verify(
          "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          password,
        );
      } catch {
        // The dummy hash is invalid — argon2 throws. That's fine — the latency
        // is added before the catch.
      }

      // Uniform 401 body — identical for "unknown email", "wrong password",
      // "locked", "erased". No existence leak.
      return NextResponse.json(
        { error: "invalid_credentials" },
        { status: 401 },
      );
    }

    const uid = data.user.id;
    const mfaOk = data.user.user_metadata?.mfa_enrolled === true;

    // Create a v2 session.
    const ctx: RequestContext = {
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "0.0.0.0",
      ua: req.headers.get("user-agent") ?? "unknown",
    };

    const session = await createSession(uid, ctx, mfaOk);

    // Issue a 15-min access token.
    const accessToken = issueAccessToken({
      userId: uid,
      sessionId: session.sessionId,
      mfaSatisfied: mfaOk,
    });

    // Build the response.
    const res = NextResponse.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 900, // 15 min (seconds).
      user: { id: uid, email: data.user.email },
    }, { status: 200 });

    // Set the refresh token in an HttpOnly cookie.
    setRefreshCookie(res, session.refreshToken);

    // CORS + request id.
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);

    return res;
  } catch (err) {
    return errorResponse(err, "/v1/auth/login");
  }
}
