import { NextResponse } from "next/server";
import { evaluatePromptVersions } from "@/lib/feedback/evaluate";
import { pino } from "@/lib/observability/logger";
import { safeEqual } from "@/lib/auth/tokens";

export const dynamic = "force-dynamic";

const log = pino.child({ route: "cron/evaluate-prompts" });

function isAuthorized(req: Request): boolean {
  const authHeader = req.headers.get("authorization");
  const expected = `Bearer ${process.env.CRON_SECRET ?? ""}`;
  if (!authHeader) return false;
  return safeEqual(authHeader, expected);
}

/**
 * POST /api/cron/evaluate-prompts
 *
 * Daily cron — evaluates prompt A/B tests and promotes statistically
 * significant winners.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` header.
 * Idempotent: safe to re-run (promotions are conditional on z-score).
 */
export async function POST(req: Request) {
  if (!isAuthorized(req)) {
    log.warn({ event: "cron_unauthorized" });
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await evaluatePromptVersions();
    log.info({
      event: "cron_complete",
      slots_evaluated: result.slotsEvaluated,
      promotions: result.promotions,
    });
    return NextResponse.json(result);
  } catch (err) {
    log.error({ event: "cron_failed", error: String(err) });
    return NextResponse.json({ error: "cron_failed" }, { status: 500 });
  }
}

// Support GET so Vercel Cron's default method works.
export const GET = POST;
