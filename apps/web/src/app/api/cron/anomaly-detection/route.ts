import { NextResponse } from "next/server";
import { safeEqual } from "@/lib/auth/tokens";
import { detectAnomalies, persistAnomalies } from "@/lib/observability/anomaly";

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

  const result = await detectAnomalies();
  await persistAnomalies(result);

  return NextResponse.json({
    detected: result.detected,
    critical: result.critical,
    warning: result.warning,
    info: result.info,
    anomalies: result.anomalies,
  });
}

export const GET = POST;
