import { NextRequest, NextResponse } from "next/server";
import { beginLogin } from "@/lib/sso/saml";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const rid = requestId(req);
  try {
    const domain = req.nextUrl.searchParams.get("domain");
    if (!domain) return NextResponse.json({ error: "domain_required" }, { status: 400 });
    const { redirectUrl } = await beginLogin(domain);
    const res = NextResponse.json({ redirectUrl }, { status: 200 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(k, v);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/sso/saml/login");
  }
}
