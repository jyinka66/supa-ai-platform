import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin/middleware";
import { queryAdminAudit } from "@/lib/admin/audit";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";

/**
 * GET /api/admin/audit
 *
 * Query the admin control-plane audit log (owner-only). Paginated, filterable
 * by actor / action / time range. For the admin audit log UI — the forensic
 * trail for "who did what in the control plane."
 *
 * The audit log is insert-only (REVOKE UPDATE/DELETE from all roles). This
 * route is read-only — it queries via the security-definer-backed queryAdminAudit
 * (RLS enforces owner-only read).
 *
 * Query params:
 *   ?actorId=<uuid>     — filter by actor.
 *   ?action=<string>    — filter by action (e.g. 'admin.invited').
 *   ?from=<ISO 8601>    — filter from timestamp.
 *   ?to=<ISO 8601>      — filter to timestamp.
 *   ?limit=<int>        — page size (default 100, max 1000).
 *   ?offset=<int>       — pagination offset (default 0).
 *
 * Response 200:
 *   {
 *     "items": [
 *       {
 *         "seq": 42,
 *         "id": "...",
 *         "actorId": "...",
 *         "action": "admin.invited",
 *         "target": { "email": "...", "role": "..." },
 *         "justification": "...",
 *         "diff": { "old": {...}, "new": {...} },
 *         "ip": "203.0.113.1",
 *         "userAgent": "...",
 *         "ts": "..."
 *       }
 *     ],
 *     "total": 1234,  // null if not computed (expensive — omitted for filtered queries)
 *     "limit": 100,
 *     "offset": 0
 *   }
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const rid = requestId(req);
  try {
    await requireAdminSession(req, "owner");

    const url = new URL(req.url);
    const actorId = url.searchParams.get("actorId") ?? undefined;
    const action = url.searchParams.get("action") ?? undefined;
    const fromParam = url.searchParams.get("from");
    const toParam = url.searchParams.get("to");
    const limitParam = url.searchParams.get("limit");
    const offsetParam = url.searchParams.get("offset");

    const fromTs = fromParam ? new Date(fromParam) : undefined;
    const toTs = toParam ? new Date(toParam) : undefined;

    // Validate timestamps.
    if (fromParam && (!fromTs || isNaN(fromTs.getTime()))) {
      return NextResponse.json(
        { error: "invalid_from_timestamp" },
        { status: 400 },
      );
    }
    if (toParam && (!toTs || isNaN(toTs.getTime()))) {
      return NextResponse.json(
        { error: "invalid_to_timestamp" },
        { status: 400 },
      );
    }

    const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 100, 1), 1000) : 100;
    const offset = offsetParam ? Math.max(parseInt(offsetParam, 10) || 0, 0) : 0;

    const items = await queryAdminAudit({
      ...(actorId ? { actorId } : {}),
      ...(action ? { action } : {}),
      ...(fromTs ? { fromTs } : {}),
      ...(toTs ? { toTs } : {}),
      limit,
      offset,
    });

    const res = NextResponse.json(
      { items, limit, offset },
      { status: 200 },
    );
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/api/admin/audit");
  }
}
