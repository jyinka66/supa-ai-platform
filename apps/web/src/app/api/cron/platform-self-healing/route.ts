import { NextResponse } from "next/server";
import { safeEqual } from "@/lib/auth/tokens";
import { runSelfHealing } from "@/lib/platform/self-healing";

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
  const report = await runSelfHealing();
  return NextResponse.json(report);
}

export const GET = POST;
