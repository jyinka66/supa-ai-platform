import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { beginTotpEnrollment } from "@/lib/auth/mfa";
import { authenticate, corsHeaders, errorResponse, jsonLimiter, requestId } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EnrollBody = z.object({ label: z.string().trim().max(254).optional() });

export async function POST(req: NextRequest) {
  const rid = requestId(req);
  try {
    jsonLimiter(req);
    const userId = await authenticate(req);
    const body = await req.json().catch(() => ({}));
    const parsed = EnrollBody.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

    const enrollment = await beginTotpEnrollment(userId, parsed.data.label);
    const res = NextResponse.json(enrollment, { status: 200 });
    for (const [key, value] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(key, value);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (error) {
    return errorResponse(error, "/v1/auth/mfa/enroll");
  }
}
