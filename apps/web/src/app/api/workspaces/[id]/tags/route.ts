import { NextRequest } from "next/server";
import { db } from "@supa/db";
import { tags, workItemTags } from "@supa/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { requireUser, assertRole } from "@/lib/auth/session";
import { guard } from "@/lib/ratelimit/guard";
import { problem, ok } from "@/lib/api/problem";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/workspaces/:id/tags
 *
 * Returns all tags for a workspace, with item counts.
 * Any workspace member can read tags.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await guard(req, "default");
  if (denied) return denied;

  const user = await requireUser();
  const { id: wsId } = await params;

  // Verify membership.
  const allowed = await assertRole(user.id, wsId, ["owner", "admin", "member", "viewer"]);
  if (!allowed) return problem(403, "forbidden");

  const rows = await db.execute<{ id: string; name: string; count: number }>(sql`
    select t.id, t.name, count(wit.item_id)::int as count
    from tags t
    left join work_item_tags wit on wit.tag_id = t.id
    left join work_items wi on wi.id = wit.item_id and wi.status = 'active'
    where t.workspace_id = ${wsId}
    group by t.id, t.name
    order by count desc, t.name asc
  `);

  return ok({ tags: Array.isArray(rows) ? rows : [] });
}
