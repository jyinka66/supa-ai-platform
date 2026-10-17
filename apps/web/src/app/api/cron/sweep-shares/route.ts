import { NextResponse } from "next/server";
import { db } from "@supa/db";
import { sql } from "drizzle-orm";
import { safeEqual } from "@/lib/auth/tokens";

/**
 * POST /api/cron/sweep-shares
 *
 * Nightly sweeper for share links. Two idempotent jobs:
 *
 *   1. Hard-revoke expired links (revoke_expired_shares()).
 *      The lazy expiry check in resolve() already denies expired links on
 *      every read, so this is just DB hygiene — keeps the
 *      `where revoked_at is null` partial index small.
 *
 *   2. Purge share_views older than 90 days.
 *      The ip_hash is a truncated SHA-256 (64 bits) — not directly PII, but
 *      we honor the 90-day retention discipline (Phase 7) to limit blast
 *      radius if the table leaks. Failed-password rows are also purged
 *      (rate-limit only needs a 15-min window; the 90d is for analytics).
 *
 * Both jobs are idempotent + resumable — same pattern as the Phase 6 purge
 * jobs (purge-trash, purge-retention). If the cron dies mid-run, the next
 * run picks up where it left off (no state to corrupt).
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` (timingSafeEqual — C4 fix).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SHARE_VIEWS_RETENTION_DAYS = 90;

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

  // 1. Hard-revoke expired links (security-definer function — idempotent).
  const revokedRows = await db.execute(sql`
    select revoke_expired_shares()
  `);
  const revokedCount = Number(
    (revokedRows as unknown as Array<{ revoke_expired_shares: number }>)[0]?.revoke_expired_shares ?? 0,
  );

  // 2. Purge share_views older than 90 days.
  //    DELETE (not truncate) — the 90d window slides, so we always keep the
  //    last 90 days. The partial index on (share_id, viewed_at desc) keeps
  //    this fast.
  const purgedRows = await db.execute(sql`
    with deleted as (
      delete from share_views
       where viewed_at < now() - interval '${SHARE_VIEWS_RETENTION_DAYS} days'
      returning 1
    )
    select count(*)::integer as n from deleted
  `);
  const purgedViews = Number(
    (purgedRows as unknown as Array<{ n: number }>)[0]?.n ?? 0,
  );

  return NextResponse.json({
    revokedExpiredLinks: revokedCount,
    purgedStaleViews: purgedViews,
    retentionDays: SHARE_VIEWS_RETENTION_DAYS,
  });
}

export const GET = POST;
