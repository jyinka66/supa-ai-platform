// POST /api/v1/auth/mfa/verify — verify TOTP code → mfa_satisfied=true → issue JWT.
//
// Flow:
//   1. Authenticate (get uid from the JWT — the user is already logged in
//      with a valid access token, but MFA is not yet satisfied).
//   2. Verify the TOTP code (or recovery code).
//   3. If valid: update the session's mfa_satisfied=true + issue a new 15-min
//      JWT with mfa=true.
//   4. Return the new access token.
//
// The MFA verification is required for re-auth-sensitive operations (ownership
// transfer, workspace deletion). The route sets mfa_satisfied on the session
// so subsequent requests within the 15-min window don't need to re-verify.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@supa/db";
import { sessions } from "@supa/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { verifyTotp } from "@/lib/auth/mfa";
import { issueAccessToken } from "@/lib/auth/session";
import { authenticate, errorResponse, requestId, jsonLimiter, corsHeaders } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MfaVerifyBody = z.object({
  code: z.string().min(6).max(26),
});

export async function POST(req: NextRequest) {
  const rid = requestId(req);
  try {
    jsonLimiter(req);
    const uid = await authenticate(req);
    const body = await req.json();
    const parsed = MfaVerifyBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_code" }, { status: 400 });
    }

    // Verify the TOTP code (or recovery code).
    const valid = await verifyTotp(uid, parsed.data.code);
    if (!valid) {
      return NextResponse.json({ error: "bad_code" }, { status: 400 });
    }

    // Extract the session id from the JWT.
    const auth = req.headers.get("authorization");
    let sessionId: string | null = null;
    if (auth && auth.startsWith("Bearer ")) {
      const token = auth.slice(7);
      try {
        const parts = token.split(".");
        if (parts.length === 3) {
          const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
          sessionId = payload.jti ?? null;
        }
      } catch {}
    }

    // Update the session's mfa_satisfied=true.
    if (sessionId) {
      await db
        .update(sessions)
        .set({ mfaSatisfied: true })
        .where(
          and(
            eq(sessions.id, sessionId as any),
            eq(sessions.userId, uid as any),
            isNull(sessions.revokedAt),
          ),
        );
    }

    // Issue a new 15-min JWT with mfa=true.
    const accessToken = issueAccessToken({
      userId: uid,
      sessionId: sessionId ?? "",
      mfaSatisfied: true,
    });

    const res = NextResponse.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 900,
      mfa_satisfied: true,
    }, { status: 200 });

    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/v1/auth/mfa/verify");
  }
}
