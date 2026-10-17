import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@supa/db";
import { sessions } from "@supa/db/schema";
import { and, eq, gt, isNull } from "drizzle-orm";
import { verifyTotp } from "@/lib/auth/mfa";
import { issueAccessToken } from "@/lib/auth/session";
import { authenticate, errorResponse, requestId, jsonLimiter, corsHeaders } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MfaVerifyBody = z.object({ code: z.string().min(6).max(26) });

function readSessionId(req: NextRequest): string | null {
  const authorization = req.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  try {
    const parts = authorization.slice(7).split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as { jti?: unknown };
    return typeof payload.jti === "string" && z.string().uuid().safeParse(payload.jti).success ? payload.jti : null;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const rid = requestId(req);
  try {
    jsonLimiter(req);
    const uid = await authenticate(req);
    const sessionId = readSessionId(req);
    if (!sessionId) return NextResponse.json({ error: "invalid_session" }, { status: 401 });

    const now = new Date();
    const active = await db.select({ id: sessions.id }).from(sessions).where(and(
      eq(sessions.id, sessionId as any),
      eq(sessions.userId, uid as any),
      isNull(sessions.revokedAt),
      gt(sessions.expiresAt, now),
      gt(sessions.idleExpiresAt, now),
    )).limit(1);
    if (!active.length) return NextResponse.json({ error: "invalid_session" }, { status: 401 });

    const body = await req.json();
    const parsed = MfaVerifyBody.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "invalid_code" }, { status: 400 });
    if (!await verifyTotp(uid, parsed.data.code)) return NextResponse.json({ error: "bad_code" }, { status: 400 });

    const updated = await db.update(sessions).set({ mfaSatisfied: true }).where(and(
      eq(sessions.id, sessionId as any),
      eq(sessions.userId, uid as any),
      isNull(sessions.revokedAt),
      gt(sessions.expiresAt, new Date()),
      gt(sessions.idleExpiresAt, new Date()),
    )).returning({ id: sessions.id });
    if (!updated.length) return NextResponse.json({ error: "invalid_session" }, { status: 401 });

    const accessToken = issueAccessToken({ userId: uid, sessionId, mfaSatisfied: true });
    const res = NextResponse.json({ access_token: accessToken, token_type: "Bearer", expires_in: 900, mfa_satisfied: true }, { status: 200 });
    for (const [key, value] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(key, value);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (error) {
    return errorResponse(error, "/v1/auth/mfa/verify");
  }
}
