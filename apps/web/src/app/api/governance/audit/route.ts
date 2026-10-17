// GET /api/governance/audit
//
// Queries the audit trail. Supports filtering by category, actor, target,
// time range.

import { adminOnly, okResponse, paginate } from "@/lib/api/route-helpers";
import {
  queryAuditTrail,
  AUDIT_EVENT_CATEGORIES,
  type AuditTrailQuery,
} from "@/lib/governance/governance-audit-trail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  const url = new URL(req.url);
  const pagination = paginate(url, { pageSize: 50, maxPageSize: 200 });

  const query: AuditTrailQuery = {
    categories: url.searchParams.getAll("category") as AuditTrailQuery["categories"],
    actorId: url.searchParams.get("actor") ?? undefined,
    action: url.searchParams.get("action") ?? undefined,
    wsId: url.searchParams.get("wsId") ?? undefined,
    fromTs: url.searchParams.get("from") ? new Date(url.searchParams.get("from")!) : undefined,
    toTs: url.searchParams.get("to") ? new Date(url.searchParams.get("to")!) : undefined,
    limit: pagination.take,
    offset: pagination.skip,
  };

  const entries = await queryAuditTrail(query);

  return okResponse({
    entries,
    categories: AUDIT_EVENT_CATEGORIES,
    page: pagination.page,
    pageSize: pagination.pageSize,
    total: entries.length,
    query,
  });
});
