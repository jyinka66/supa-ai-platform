// GET /api/builder/sessions
//
// Lists build sessions, optionally filtered by owner / workspace / status.
// Returns the most recent first.
//
// Query params:
//   ownerId?: string
//   wsId?: string
//   status?: BuildSessionStatus
//   page?: number (default 1)
//   pageSize?: number (default 20, max 100)

import { adminOnly, okResponse, paginate } from "@/lib/api/route-helpers";
import { listBuildSessions, type BuildSessionStatus } from "@/lib/builder/build-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  const url = new URL(req.url);
  const pagination = paginate(url, { pageSize: 20 });

  const sessions = await listBuildSessions({
    ownerId: url.searchParams.get("ownerId") ?? undefined,
    wsId: url.searchParams.get("wsId") ?? undefined,
    status: (url.searchParams.get("status") as BuildSessionStatus | null) ?? undefined,
    limit: pagination.take,
    offset: pagination.skip,
  });

  return okResponse({
    sessions,
    page: pagination.page,
    pageSize: pagination.pageSize,
    total: sessions.length,
  });
});
