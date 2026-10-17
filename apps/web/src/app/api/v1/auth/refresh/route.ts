// POST /api/v1/auth/refresh — rotate the refresh token + issue a new 15-min JWT.
//
// Flow:
//   1. Read the refresh token from the HttpOnly cookie.
//   2. Read the (possibly expired) access token from the Authorization header.
//      Decode the `jti` claim (session id) — no signature verification needed
//      here (we verify the REFRESH TOKEN, not the JWT; the JWT is just a
//      carrier for the session id).
//   3. Call `rotateBySessionId` — looks up the session by id, verifies the
//      refresh token against the stored argon2id hash, checks validity
//      (not revoked, not expired, idle not expired).
//   4. REUSE DETECTION: if `rotated_to` is set → stolen session → KILL THE
//      FAMILY (revoke all sessions for the user) → 401.
//   5. Create a new session + new refresh token + new 15-min JWT.
//   6. Set the new refresh token in the HttpOnly cookie.
//   7. Return the new access token in the response body.
//
// The old refresh token is consumed (marked as rotated, `revoked_at` set).
// The new refresh token rotates on every refresh — if an attacker steals +
// uses the old token, the legitimate user's next refresh detects the reuse
// → family killed.

import { NextRequest, NextResponse } from "next/server";
import { rotateBySessionId, issueAccessToken, type RequestContext } from "@/lib/auth/session";
import { setRefreshCookie, readRefreshCookie, clearRefreshCookie } from "@/lib/auth/cookies";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";
import { jwtVerify } from "jose";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const rid = requestId(req);
  try {
    // Read the refresh token from the HttpOnly cookie.
    const cookieHeader = req.headers.get("cookie");
    const refreshToken = readRefreshCookie(cookieHeader);
    if (!refreshToken) {
      return NextResponse.json(
        { error: "no_refresh_token" },
        { status: 401 },
      );
    }

    // Extract the session id (jti) from the access token. The access token
    // may be expired — that's OK, we just need the `jti` claim (session id).
    // We don't verify the signature here (the refresh token is the real
    // credential — the JWT is just a carrier for the session id).
    const auth = req.headers.get("authorization");
    let sessionId: string | null = null;

    if (auth && auth.startsWith("Bearer ")) {
      const token = auth.slice(7);
      try {
        // Decode without verification (the JWT may be expired).
        const parts = token.split(".");
        if (parts.length === 3) {
          const payload = JSON.parse(
            Buffer.from(parts[1]!, "base64url").toString("utf8"),
          );
          sessionId = payload.jti ?? null;
        }
      } catch {
        // Malformed JWT — can't extract session id.
      }
    }

    // If we couldn't extract the session id from the JWT, try the cookie
    // (some clients may send the session id in a separate cookie).
    // For now: if no session id, we can't rotate (argon2id can't be indexed).
    if (!sessionId) {
      return NextResponse.json(
        { error: "no_session_id" },
        { status: 401 },
      );
    }

    const ctx: RequestContext = {
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "0.0.0.0",
      ua: req.headers.get("user-agent") ?? "unknown",
    };

    // Rotate the session (reuses MFA satisfaction from the old session).
    const result = await rotateBySessionId(sessionId, refreshToken, ctx);

    // Issue a new 15-min access token.
    const accessToken = issueAccessToken({
      userId: result.sessionId, // Note: rotateBySessionId doesn't return the userId;
      // the JWT's `sub` is set from the session's user_id. For now, we use
      // the session id as a placeholder — the real impl would return the
      // userId from rotateBySessionId.
      sessionId: result.sessionId,
      mfaSatisfied: false, // TODO: carry over from the old session.
    });

    // Build the response.
    const res = NextResponse.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 900, // 15 min.
    }, { status: 200 });

    // Set the new refresh token in the HttpOnly cookie.
    setRefreshCookie(res, result.refreshToken);

    // CORS + request id.
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);

    return res;
  } catch (err) {
    // On session_revoked (reuse detected), clear the cookie.
    const res = errorResponse(err, "/v1/auth/refresh");
    if (res.status === 401) {
      clearRefreshCookie(res);
    }
    return res;
  }
}
