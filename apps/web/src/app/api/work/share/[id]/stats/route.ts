import { NextRequest } from "next/server";
import { db } from "@supa/db";
import { workShareLinks, workShareViews } from "@supa/db/schema";
import { eq, sql, and, gte, desc } from "drizzle-orm";
import { requireUser } from "@/lib/auth/session";
import { guard } from "@/lib/ratelimit/guard";
import { problem, ok } from "@/lib/api/problem";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ShareStats {
  linkId: string;
  totalViews: number;
  uniqueIps: number;
  avgDwellMs: number | null;
  viewsByDay: Array<{ day: string; views: number }>;
  topCountries: Array<{ country: string; views: number }>;
  topReferrers: Array<{ referrer: string; views: number }>;
}

/**
 * GET /api/work/share/:id/stats
 *
 * Returns analytics for a share link.
 *
 * Auth: only the share link creator can view stats.
 *
 * Stats include:
 *   - totalViews, uniqueIps, avgDwellMs
 *   - viewsByDay (last 30 days)
 *   - topCountries (top 5)
 *   - topReferrers (top 5)
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await guard(req, "default");
  if (denied) return denied;

  const user = await requireUser();
  const { id } = await params;

  // Verify ownership.
  const linkRows = await db
    .select({ createdBy: workShareLinks.createdBy })
    .from(workShareLinks)
    .where(eq(workShareLinks.id, id))
    .limit(1);

  if (!linkRows[0]) return problem(404, "not_found");
  if (linkRows[0].createdBy !== user.id) return problem(403, "forbidden");

  // Run all stat queries in parallel.
  const [totalRow, uniqueIpRow, dwellRow, dailyRows, countryRows, referrerRows] = await Promise.all([
    // Total views.
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(workShareViews)
      .where(eq(workShareViews.shareLinkId, id)),

    // Unique IPs.
    db
      .select({ count: sql<number>`count(distinct ip_hash)::int` })
      .from(workShareViews)
      .where(eq(workShareViews.shareLinkId, id)),

    // Average dwell time.
    db
      .select({ avg: sql<number>`avg(duration_ms)::float` })
      .from(workShareViews)
      .where(
        and(
          eq(workShareViews.shareLinkId, id),
          sql`duration_ms is not null`,
        ),
      ),

    // Views by day (last 30 days).
    db.execute<{ day: string; views: number }>(sql`
      select date_trunc('day', viewed_at)::date::text as day, count(*)::int as views
      from work_share_views
      where share_link_id = ${id}
        and viewed_at >= now() - interval '30 days'
      group by 1
      order by 1 desc
    `),

    // Top countries (top 5).
    db.execute<{ country: string; views: number }>(sql`
      select coalesce(country, 'Unknown') as country, count(*)::int as views
      from work_share_views
      where share_link_id = ${id}
        and country is not null
      group by 1
      order by views desc
      limit 5
    `),

    // Top referrers (top 5).
    db.execute<{ referrer: string; views: number }>(sql`
      select coalesce(left(referrer, 100), 'Direct') as referrer, count(*)::int as views
      from work_share_views
      where share_link_id = ${id}
        and referrer is not null
      group by 1
      order by views desc
      limit 5
    `),
  ]);

  const stats: ShareStats = {
    linkId: id,
    totalViews: totalRow[0]?.count ?? 0,
    uniqueIps: uniqueIpRow[0]?.count ?? 0,
    avgDwellMs: dwellRow[0]?.avg ?? null,
    viewsByDay: (Array.isArray(dailyRows) ? dailyRows : []).map((r: { day: string; views: number }) => ({
      day: r.day,
      views: r.views,
    })),
    topCountries: (Array.isArray(countryRows) ? countryRows : []).map((r: { country: string; views: number }) => ({
      country: r.country,
      views: r.views,
    })),
    topReferrers: (Array.isArray(referrerRows) ? referrerRows : []).map((r: { referrer: string; views: number }) => ({
      referrer: r.referrer,
      views: r.views,
    })),
  };

  return ok(stats);
}
