import { NextRequest } from "next/server";
import { db } from "@supa/db";
import { workItemVersions } from "@supa/db/schema";
import { eq, desc, sql } from "drizzle-orm";
import { requireUser } from "@/lib/auth/session";
import { guard } from "@/lib/ratelimit/guard";
import { problem, ok } from "@/lib/api/problem";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/work/items/:id/versions
 *
 * Returns the version history for a work item.
 * Sorted newest-first.
 *
 * Each version includes:
 *   - id, version, editor (edited_by), source, created_at
 *   - sizeDelta: byte difference from the previous version (positive = grew, negative = shrank)
 *
 * Limited to 100 versions (enough for any realistic edit history).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await guard(req, "default");
  if (denied) return denied;

  await requireUser();
  const { id } = await params;

  // Fetch versions with a window function for size delta.
  const rows = await db.execute<{
    id: string;
    version: number;
    title: string | null;
    content: string | null;
    edited_by: string | null;
    source: string;
    created_at: Date;
    storage_key: string | null;
    content_size: number;
    prev_size: number | null;
  }>(sql`
    select
      v.id,
      v.version,
      v.title,
      v.content,
      v.edited_by,
      v.source,
      v.created_at,
      v.storage_key,
      coalesce(length(v.content), 0) as content_size,
      lag(coalesce(length(v.content), 0)) over (order by v.version) as prev_size
    from work_item_versions v
    where v.item_id = ${id}
    order by v.version desc
    limit 100
  `);

  const versions = (Array.isArray(rows) ? rows : []).map((r) => ({
    id: r.id,
    version: r.version,
    title: r.title,
    editedBy: r.edited_by,
    source: r.source,
    createdAt: r.created_at,
    storageKey: r.storage_key,
    sizeBytes: r.content_size,
    sizeDelta: r.prev_size !== null ? r.content_size - r.prev_size : null,
  }));

  return ok({ versions });
}
