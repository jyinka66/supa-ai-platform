import { NextRequest } from "next/server";
import { db } from "@supa/db";
import { workItems } from "@supa/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { requireUser } from "@/lib/auth/session";
import { guard } from "@/lib/ratelimit/guard";
import { problem, ok } from "@/lib/api/problem";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DELETE /api/trash
 *
 * Empties all trash for the caller in the current workspace.
 * Hard-deletes all trashed items (cascades to versions, tags, links, shares).
 * Batched — if >500 items, the caller should retry until `remaining === 0`.
 */
export async function DELETE(req: NextRequest) {
  const denied = await guard(req, "default");
  if (denied) return denied;

  const user = await requireUser();
  const wsCookie = req.cookies.get("ws")?.value;
  if (!wsCookie) return problem(400, "no_workspace_selected");

  // Delete in batches of 500.
  const BATCH = 500;
  const result = await db.execute(sql`
    delete from work_items
    where id in (
      select id from work_items
      where workspace_id = ${wsCookie}
        and owner_id = ${user.id}
        and status = 'trash'
      limit ${BATCH}
    )
    returning id
  `);

  const deleted = Array.isArray(result) ? result.length : 0;

  // Check if more remain.
  const remaining = await db.execute<{ count: number }>(sql`
    select count(*)::int as count
    from work_items
    where workspace_id = ${wsCookie}
      and owner_id = ${user.id}
      and status = 'trash'
  `);
  const remainingCount = (remaining[0] as { count?: number })?.count ?? 0;

  return ok({
    deleted,
    remaining: remainingCount,
    hasMore: remainingCount > 0,
  });
}
