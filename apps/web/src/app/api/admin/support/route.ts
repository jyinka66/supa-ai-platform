import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin/middleware";
import { getSupportAnalytics, listTickets } from "@/lib/support/tickets";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const rid = requestId(req);
  try {
    await requireAdminSession(req);
    const url = new URL(req.url);
    const status = url.searchParams.get("status") as "open" | "pending" | "resolved" | "closed" | "escalated" | undefined;
    const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);

    const [analytics, tickets] = await Promise.all([
      getSupportAnalytics(),
      listTickets({ ...(status ? { status } : {}), limit }),
    ]);

    const res = NextResponse.json({ analytics, tickets }, { status: 200 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(k, v);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/api/admin/support");
  }
}
