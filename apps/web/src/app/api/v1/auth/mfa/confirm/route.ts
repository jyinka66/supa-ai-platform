import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { confirmTotpEnrollment } from "@/lib/auth/mfa";
import { authenticate, corsHeaders, errorResponse, jsonLimiter, requestId } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ConfirmBody = z.object({ code: z.string().regex(/^\d{6}$/) });

export async function POST(req: NextRequest) {
  const rid = requestId(req);
  try {
    jsonLimiter(req);
    const userId = await authenticate(req);
    const body = await req.json();
    const parsed = ConfirmBody.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "invalid_code" }, { status: 400 });

    const recoveryCodes = await confirmTotpEnrollment(userId, parsed.data.code);
    if (!recoveryCodes) return NextResponse.json({ error: "bad_code" }, { status: 400 });

    const res = NextResponse.json({ enrolled: true, recovery_codes: recoveryCodes }, { status: 200 });
    for (const [key, value] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(key, value);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (error) {
    return errorResponse(error, "/v1/auth/mfa/confirm");
  }
}
