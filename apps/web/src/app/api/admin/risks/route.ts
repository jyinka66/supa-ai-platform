import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin/middleware";
import { listRisks, getRiskSummary } from "@/lib/phase11/risks";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const rid = requestId(req);
  try {
    await requireAdminSession(req, "owner");
    const url = new URL(req.url);
    const category = url.searchParams.get("category") ?? undefined;
    const status = url.searchParams.get("status") as "implemented" | "in_progress" | "planned" | "not_started" | undefined;

    const [risks, summary] = await Promise.all([
      listRisks({ ...(category ? { category } : {}), ...(status ? { status } : {}) }),
      getRiskSummary(),
    ]);

    const res = NextResponse.json({ risks, summary }, { status: 200 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(k, v);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/api/admin/risks");
  }
}
