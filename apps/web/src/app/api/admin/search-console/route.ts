import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin/middleware";
import { getSearchConsoleReport, isSearchConsoleConfigured } from "@/lib/seo/search-console";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";

/**
 * GET /api/admin/search-console
 *
 * Search Console integration (owner-only). Returns the site's search performance:
 * impressions, clicks, position, CTR, top pages, top queries, indexing errors.
 *
 * The spec: "Search Console integration — impressions, clicks, positions,
 * errors monitored automatically."
 *
 * Query params:
 *   ?from=<ISO 8601>  — start of the range (default: 28 days ago).
 *   ?to=<ISO 8601>    — end of the range (default: now).
 *
 * Response 200:
 *   {
 *     "configured": true,
 *     "report": {
 *       "dateRange": { "from": "...", "to": "..." },
 *       "totals": { "impressions": 0, "clicks": 0, "position": 0, "ctr": 0 },
 *       "topPages": [...],
 *       "topQueries": [...],
 *       "errors": [...],
 *       "coverage": { "indexed": 0, "notIndexed": 0, "errors": 0 }
 *     }
 *   }
 *
 * If Search Console isn't configured (GOOGLE_APPLICATION_CREDENTIALS unset),
 * returns `configured: false` + an empty report (the dashboard shows a
 * "connect Search Console" prompt).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const rid = requestId(req);
  try {
    await requireAdminSession(req, "owner");

    const url = new URL(req.url);
    const fromParam = url.searchParams.get("from");
    const toParam = url.searchParams.get("to");

    const toTs = toParam ? new Date(toParam) : new Date();
    const fromTs = fromParam ? new Date(fromParam) : new Date(Date.now() - 28 * 86400000);

    if (isNaN(fromTs.getTime())) {
      return NextResponse.json({ error: "invalid_from" }, { status: 400 });
    }
    if (isNaN(toTs.getTime())) {
      return NextResponse.json({ error: "invalid_to" }, { status: 400 });
    }

    const configured = isSearchConsoleConfigured();
    const report = await getSearchConsoleReport(fromTs, toTs);

    const res = NextResponse.json(
      { configured, report },
      { status: 200 },
    );
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/api/admin/search-console");
  }
}
