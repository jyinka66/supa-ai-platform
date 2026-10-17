import { NextRequest, NextResponse } from "next/server";
import { consumeAssertion } from "@/lib/sso/saml";
import { setRefreshCookie } from "@/lib/auth/cookies";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const rid = requestId(req);
  try {
    const formData = await req.formData();
    const samlResponse = formData.get("SAMLResponse") as string;
    const relayState = formData.get("RelayState") as string | null;
    if (!samlResponse) return NextResponse.json({ error: "no_saml_response" }, { status: 400 });
    const result = await consumeAssertion(samlResponse, relayState ?? undefined);
    const res = NextResponse.json({ access_token: result.accessToken, mfa_satisfied: result.mfaSatisfied }, { status: 200 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(k, v);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/sso/saml/callback");
  }
}
