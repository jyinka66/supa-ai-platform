import { NextRequest } from "next/server";
import { db } from "@supa/db";
import { workItems } from "@supa/db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { requireUser, assertRole } from "@/lib/auth/session";
import { guard } from "@/lib/ratelimit/guard";
import { problem, ok } from "@/lib/api/problem";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

/**
 * GET /api/workspaces/:id/trash
 *
 * Returns trashed items for the caller (owner-only visibility per RLS).
 * Cursor-based pagination via ?cursor=<ISO timestamp>.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await guard(req, "default");
  if (denied) return denied;

  const user = await requireUser();
  const { id: wsId } = await params;

  const allowed = await assertRole(user.id, wsId, ["owner", "admin", "member", "viewer"]);
  if (!allowed) return problem(403, "forbidden");

  const url = new URL(req.url);
  const cursor = url.searchParams.get("cursor");

  // Build the query — trashed items owned by the caller.
  const conditions = [
    eq(workItems.workspaceId, wsId),
    eq(workItems.status, "trash"),
    eq(workItems.ownerId, user.id),
  ];

  if (cursor) {
    conditions.push(sql`${workItems.trashedAt} < ${cursor}`);
  }

  const items = await db
    .select({
      id: workItems.id,
      title: workItems.title,
      type: workItems.type,
      thumbnailUrl: workItems.thumbnailUrl,
      favorite: workItems.favorite,
      trashedAt: workItems.trashedAt,
      trashedBy: workItems.trashedBy,
      updatedAt: workItems.updatedAt,
    })
    .from(workItems)
    .where(and(...conditions))
    .orderBy(desc(workItems.trashedAt))
    .limit(PAGE_SIZE + 1); // +1 for hasMore

  const hasMore = items.length > PAGE_SIZE;
  const page = hasMore ? items.slice(0, PAGE_SIZE) : items;
  const nextCursor = hasMore ? page[page.length - 1]!.trashedAt?.toISOString() : null;

  return ok({ items: page, hasMore, nextCursor });
}
