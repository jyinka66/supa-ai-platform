import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin/middleware";
import { listDeployments, getDeployment } from "@/lib/platform/enterprise-deployments";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";

export async function GET(req: NextRequest) {
  const rid = requestId(req);
  try {
    await requireAdminSession(req);
    const url = new URL(req.url);
    const wsId = url.searchParams.get("wsId") ?? undefined;
    const status = url.searchParams.get("status") as any;
    const deployments = await listDeployments({ ...(wsId ? { wsId } : {}), ...(status ? { status } : {}) });
    const res = NextResponse.json({ items: deployments }, { status: 200 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(k, v);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/api/admin/platform/deployments");
  }
}
