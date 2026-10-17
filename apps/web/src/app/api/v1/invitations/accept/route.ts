import { NextRequest } from "next/server";
import { authenticate, requestId, jsonLimiter, errorResponse, corsHeaders } from "@/lib/http/middleware";
import { acceptInviteSecure } from "@/lib/members/service";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const rid = requestId(req);
  try {
    jsonLimiter(req);
    const uid = await authenticate(req);
    const body = await req.json();
    const result = await acceptInviteSecure(body.token, uid);
    const res = new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(k, v);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, `/v1/invitations/accept`);
  }
}
