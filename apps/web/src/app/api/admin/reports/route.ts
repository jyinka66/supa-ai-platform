import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin/middleware";
import { listReports, getLatestReport, generateReport } from "@/lib/observability/reports";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const rid = requestId(req);
  try {
    await requireAdminSession(req, "owner");
    const url = new URL(req.url);
    const period = url.searchParams.get("period") as "weekly" | "monthly" | "quarterly" | undefined;
    const latest = url.searchParams.get("latest") === "true";

    if (latest && period) {
      const report = await getLatestReport(period);
      const res = NextResponse.json(report, { status: 200 });
      for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(k, v);
      res.headers.set("X-Request-Id", rid);
      return res;
    }

    const reports = await listReports(period ?? undefined, 12);
    const res = NextResponse.json({ items: reports }, { status: 200 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(k, v);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/api/admin/reports");
  }
}

export async function POST(req: NextRequest) {
  const rid = requestId(req);
  try {
    await requireAdminSession(req, "owner");
    const url = new URL(req.url);
    const period = url.searchParams.get("period") as "weekly" | "monthly" | "quarterly";
    if (!period || !["weekly", "monthly", "quarterly"].includes(period)) {
      return NextResponse.json({ error: "invalid_period" }, { status: 400 });
    }
    const report = await generateReport(period);
    const res = NextResponse.json(report, { status: 201 });
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) res.headers.set(k, v);
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/api/admin/reports");
  }
}
