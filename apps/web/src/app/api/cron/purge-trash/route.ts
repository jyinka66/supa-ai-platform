import { NextResponse } from "next/server";
import { purgeExpiredTrash } from "@supa/jobs";
import { pino } from "@/lib/observability/logger";
import { safeEqual } from "@/lib/auth/tokens";

export const dynamic = "force-dynamic";

const log = pino.child({ route: "cron/purge-trash" });

function isAuthorized(req: Request): boolean {
  const authHeader = req.headers.get("authorization");
  const expected = `Bearer ${process.env.CRON_SECRET ?? ""}`;
  if (!authHeader) return false;
  return safeEqual(authHeader, expected);
}

/**
 * POST /api/cron/purge-trash
 *
 * Daily cron — hard-deletes work items that have been in trash for
 * longer than 30 days. Also deletes associated files from Supabase Storage.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}`.
 * Idempotent: safe to re-run.
 */
export async function POST(req: Request) {
  if (!isAuthorized(req)) {
    log.warn({ event: "cron_unauthorized" });
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await purgeExpiredTrash();
    log.info({
      event: "cron_complete",
      purged: result.purgedCount,
      file_errors: result.fileErrors,
    });
    return NextResponse.json(result);
  } catch (err) {
    log.error({ event: "cron_failed", error: String(err) });
    return NextResponse.json({ error: "cron_failed" }, { status: 500 });
  }
}

export const GET = POST;
