import { NextResponse } from "next/server";
import { safeEqual } from "@/lib/auth/tokens";
import {
  findStaleContent,
  checkAllLinks,
  auditContentFreshness,
  auditBrokenLinks,
} from "@/lib/content/freshness";

/**
 * POST /api/cron/content-freshness
 *
 * Nightly content health check. Two jobs:
 *
 *   1. Stale content detection — finds published blog posts + help articles
 *      not updated in 365 days. Emits an audit alert for the content team
 *      to review + refresh.
 *
 *   2. Broken link detection — checks all internal + external links in
 *      published content. Emits an audit alert for broken links (4xx/5xx
 *      or fetch failure).
 *
 * The spec: "Automated content freshness — pages that haven't been updated
 * in 12 months flagged for review." + "Automated broken link detection —
 * internal and external links checked regularly."
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` (timingSafeEqual — C4 fix).
 *
 * NOTE: the broken link check is currently a stub (checkAllLinks returns
 * empty — the structure is in place; the real impl iterates all published
 * content + checks each link). The staleness check is fully wired.
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

  // 1. Stale content detection.
  const freshnessReport = await findStaleContent();
  await auditContentFreshness(freshnessReport);

  // 2. Broken link detection (stub — structure in place).
  const brokenLinkReport = await checkAllLinks();
  await auditBrokenLinks(brokenLinkReport);

  return NextResponse.json({
    stale: {
      count: freshnessReport.staleCount,
      oldestDays: freshnessReport.staleItems.length > 0
        ? Math.max(...freshnessReport.staleItems.map((i) => i.daysStale))
        : 0,
      types: [...new Set(freshnessReport.staleItems.map((i) => i.type))],
    },
    brokenLinks: {
      checked: brokenLinkReport.checkedCount,
      broken: brokenLinkReport.brokenCount,
    },
  });
}

export const GET = POST;
