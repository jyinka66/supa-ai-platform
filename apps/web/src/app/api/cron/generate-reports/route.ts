import { NextResponse } from "next/server";
import { safeEqual } from "@/lib/auth/tokens";
import { generateReport } from "@/lib/observability/reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorized(req: Request): boolean {
  const authHeader = req.headers.get("authorization");
  const expected = `Bearer ${process.env.CRON_SECRET ?? ""}`;
  if (!authHeader) return false;
  return safeEqual(authHeader, expected);
}

export async function POST(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const period = url.searchParams.get("period") as "weekly" | "monthly" | "quarterly";
  if (!period || !["weekly", "monthly", "quarterly"].includes(period)) {
    return NextResponse.json({ error: "invalid_period" }, { status: 400 });
  }

  const report = await generateReport(period);

  return NextResponse.json({
    reportId: report.id,
    period: report.period,
    periodStart: report.periodStart.toISOString(),
    periodEnd: report.periodEnd.toISOString(),
    distributed: report.distributed,
  });
}

export const GET = POST;
