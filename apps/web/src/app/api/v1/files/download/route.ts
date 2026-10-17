import { NextRequest, NextResponse } from "next/server";
import { authenticate, requestId, billingGate, errorResponse, corsHeaders } from "@/lib/http/middleware";
import { downloadUrl } from "@/lib/files/upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const rid = requestId(req);
  try {
    const uid = await authenticate(req);
    const wsId = req.nextUrl.searchParams.get("wsId");
    const fileId = req.nextUrl.searchParams.get("fileId");
    const version = req.nextUrl.searchParams.get("version");
    if (!wsId || !fileId) return NextResponse.json({ error: "wsId_and_fileId_required" }, { status: 400 });
    await billingGate(wsId, "GET");
    const url = await downloadUrl(uid, wsId, fileId, version ? parseInt(version, 10) : undefined);
    const res = NextResponse.json({ url }, { status: 200 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(k, v);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/v1/files/download");
  }
}
