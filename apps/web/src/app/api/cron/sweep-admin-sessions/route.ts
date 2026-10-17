import { NextResponse } from "next/server";
import { safeEqual } from "@/lib/auth/tokens";
import { reapExpiredAdminSessions } from "@/lib/admin/auth";
import { listOverdueReviews, type OverdueReview } from "@/lib/admin/invite";
import { db } from "@supa/db";
import { sql } from "drizzle-orm";

/**
 * POST /api/cron/sweep-admin-sessions
 *
 * Nightly reaper for the admin control plane. Two idempotent jobs:
 *
 *   1. Purge admin_sessions past their hard cap (8h) OR idle timeout (30min)
 *      OR revoked. These are already invalid (verifyAdminSession rejects them),
 *      but the reaper cleans up the DB so the candidate set stays small
 *      (verifyAdminSession iterates active sessions — argon2id can't be indexed).
 *
 *   2. Alert on admins overdue for quarterly review (>90 days since last
 *      review). The alert is an audit log entry (global system event) —
 *      the admin's sessions are NOT auto-revoked (the review is a human gate).
 *      The admin UI flags overdue admins.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` (timingSafeEqual — C4 fix).
 */

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

  // 1. Purge expired/revoked admin sessions.
  const { purged } = await reapExpiredAdminSessions();

  // 2. Alert on overdue quarterly reviews.
  const overdue = await listOverdueReviews();
  if (overdue.length > 0) {
    // Emit an audit alert (global system event). The ops team monitors the
    // audit log for this action + pings the security channel.
    try {
      await db.execute(sql`
        select enterprise_audit_log_append(
          null::uuid, 'system', 'admin-review-cron', 'admin.review.overdue',
          ${JSON.stringify({ count: overdue.length, admins: overdue.map((o) => o.userId) })}::jsonb,
          null::inet, null::text
        )
      `);
    } catch {
      // Audit failure must not fail the cron.
      console.error("[admin-cron] failed to emit overdue review alert");
    }
  }

  return NextResponse.json({
    purgedSessions: purged,
    overdueReviews: overdue.length,
    overdueAdmins: overdue.map((o: OverdueReview) => ({
      userId: o.userId,
      role: o.role,
      daysOverdue: o.daysOverdue,
    })),
  });
}

export const GET = POST;
