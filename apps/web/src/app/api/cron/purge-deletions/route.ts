import { NextResponse } from "next/server";
import { purgeDueDeletions } from "@supa/jobs";
import { pino } from "@/lib/observability/logger";
import { safeEqual } from "@/lib/auth/tokens";

export const dynamic = "force-dynamic";

function isAuthorized(req: Request): boolean {
  const authHeader = req.headers.get("authorization");
  const expected = `Bearer ${process.env.CRON_SECRET ?? ""}`;
  if (!authHeader) return false;
  // Use constant-time comparison to prevent timing attacks on the secret.
  return safeEqual(authHeader, expected);
}

/**
 * POST /api/cron/purge-deletions
 *
 * Triggered by Vercel Cron (or external scheduler). Authenticates via
 * CRON_SECRET bearer token — never publicly callable.
 *
 * Idempotent: re-running on the same day is safe. Each user is purged
 * at most once because deletion_requests row is removed after success.
 */
export async function POST(req: Request) {
  const log = pino.child({ route: "cron/purge-deletions" });

  if (!isAuthorized(req)) {
    log.warn({ event: "cron_unauthorized" });
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const results = await purgeDueDeletions();
    const succeeded = results.filter((r) => r.purged).length;
    const failed = results.filter((r) => !r.purged).length;

    log.info({ event: "cron_complete", succeeded, failed });
    return NextResponse.json({ succeeded, failed, total: results.length });
  } catch (err) {
    log.error({ event: "cron_failed", error: String(err) });
    return NextResponse.json({ error: "cron_failed" }, { status: 500 });
  }
}

// Also support GET so Vercel Cron's default method works.
export const GET = POST;
