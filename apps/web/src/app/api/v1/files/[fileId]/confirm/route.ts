import { NextRequest, NextResponse } from "next/server";
import { authenticate, requestId, billingGate, errorResponse, corsHeaders } from "@/lib/http/middleware";
import { confirmUpload } from "@/lib/files/upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ fileId: string }> }) {
  const rid = requestId(req);
  try {
    const { fileId } = await params;
    const uid = await authenticate(req);
    await confirmUpload(uid, fileId);
    const res = new NextResponse(null, { status: 204 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(k, v);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    const { fileId } = await params.catch(() => ({ fileId: "" }));
    return errorResponse(err, `/v1/files/${fileId}/confirm`);
  }
}
