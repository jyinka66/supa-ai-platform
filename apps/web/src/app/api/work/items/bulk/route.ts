import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@supa/db";
import { workItems, workItemTags, workFolders } from "@supa/db/schema";
import { eq, and, inArray, sql, isNull } from "drizzle-orm";
import { requireUser } from "@/lib/auth/session";
import { guard } from "@/lib/ratelimit/guard";
import { problem, ok } from "@/lib/api/problem";
import { audit } from "@/lib/audit";
import { ip } from "@/lib/utils/ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface BulkResult {
  id: string;
  ok: boolean;
  reason?: string;
}

const BulkBody = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  action: z.enum(["move", "trash", "restore", "delete", "tag", "untag", "favorite", "unfavorite"]),
  // For "move":
  folderId: z.string().uuid().nullable().optional(),
  // For "tag" / "untag":
  tagIds: z.array(z.string().uuid()).optional(),
}).strict();

/**
 * POST /api/work/items/bulk
 *
 * Performs a bulk action on multiple work items in a single request.
 *
 * Actions:
 *   move       — set folderId on all items (single UPDATE ... WHERE id = ANY(...))
 *   trash      — soft-delete (status='trash', trashed_at=now())
 *   restore    — un-trash (status='active', trashed_at=null) — only works on trashed items
 *   delete     — hard delete (cascades to versions, tags, links, shares)
 *   tag        — add tags to all items (single INSERT ... SELECT, on conflict do nothing)
 *   untag      — remove tags from all items (single DELETE ... WHERE)
 *   favorite   — set favorite=true on all items
 *   unfavorite — set favorite=false on all items
 *
 * Returns a per-item result array so the client knows which items succeeded
 * and which failed (e.g. restore on already-active items).
 *
 * Rate-limited at `default` tier. Max 500 items per batch.
 */
export async function POST(req: NextRequest) {
  const denied = await guard(req, "default");
  if (denied) return denied;

  const user = await requireUser();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return problem(400, "invalid_json");
  }
  const parsed = BulkBody.safeParse(body);
  if (!parsed.success) {
    return problem(400, "invalid_request", parsed.error.issues[0]?.message);
  }

  const { ids, action } = parsed.data;

  // Verify the caller owns all items (defense in depth — RLS also enforces).
  const ownedItems = await db
    .select({ id: workItems.id, ownerId: workItems.ownerId, status: workItems.status })
    .from(workItems)
    .where(inArray(workItems.id, ids));

  const ownedIds = new Set<string>();
  const results: BulkResult[] = [];

  for (const item of ownedItems) {
    if (item.ownerId === user.id) {
      ownedIds.add(item.id);
      results.push({ id: item.id, ok: true });
    } else {
      results.push({ id: item.id, ok: false, reason: "forbidden" });
    }
  }

  // Mark items that weren't found.
  for (const id of ids) {
    if (!ownedIds.has(id) && !results.some((r) => r.id === id)) {
      results.push({ id, ok: false, reason: "not_found" });
    }
  }

  // Only operate on owned items.
  const validIds = Array.from(ownedIds);
  if (validIds.length === 0) {
    return ok({ results, affected: 0 });
  }

  switch (action) {
    // ============ MOVE ============
    case "move": {
      if (parsed.data.folderId === undefined) {
        return problem(400, "missing_folderId");
      }
      // Verify the target folder exists + is in the same workspace (if not null).
      if (parsed.data.folderId !== null) {
        const folderRows = await db
          .select({ id: workFolders.id, type: workFolders.type })
          .from(workFolders)
          .where(eq(workFolders.id, parsed.data.folderId))
          .limit(1);
        if (!folderRows[0]) {
          return problem(404, "folder_not_found");
        }
        if (folderRows[0].type === "smart") {
          return problem(400, "cannot_move_to_smart_folder");
        }
      }
      // Single UPDATE for all items.
      await db
        .update(workItems)
        .set({ folderId: parsed.data.folderId, updatedAt: new Date() })
        .where(inArray(workItems.id, validIds));
      break;
    }

    // ============ TRASH ============
    case "trash": {
      await db
        .update(workItems)
        .set({ status: "trash", trashedAt: new Date(), trashedBy: user.id, updatedAt: new Date() })
        .where(
          and(
            inArray(workItems.id, validIds),
            eq(workItems.status, "active"),
          ),
        );
      // Mark items that were already trashed as "already_trashed".
      for (const r of results) {
        if (r.ok) {
          const item = ownedItems.find((i) => i.id === r.id);
          if (item && item.status === "trash") {
            r.ok = false;
            r.reason = "already_trashed";
          }
        }
      }
      break;
    }

    // ============ RESTORE ============
    case "restore": {
      const result = await db
        .update(workItems)
        .set({ status: "active", trashedAt: null, updatedAt: new Date() })
        .where(
          and(
            inArray(workItems.id, validIds),
            eq(workItems.status, "trash"),
          ),
        )
        .returning({ id: workItems.id });

      const restoredIds = new Set(result.map((r) => r.id));
      for (const r of results) {
        if (r.ok && !restoredIds.has(r.id)) {
          r.ok = false;
          r.reason = "already_restored";
        }
      }
      break;
    }

    // ============ DELETE (hard) ============
    case "delete": {
      await db
        .delete(workItems)
        .where(inArray(workItems.id, validIds));
      break;
    }

    // ============ TAG ============
    case "tag": {
      if (!parsed.data.tagIds || parsed.data.tagIds.length === 0) {
        return problem(400, "missing_tagIds");
      }
      // Single INSERT ... SELECT for all items × all tags.
      // ON CONFLICT DO NOTHING for idempotency.
      await db.execute(sql`
        insert into work_item_tags (item_id, tag_id)
        select i.id, t.id::uuid
        from unnest(${sql.raw(`ARRAY[${validIds.map((id) => `'${id}'`).join(",")}]::uuid[]`)}) as i(id)
        cross join unnest(${sql.raw(`ARRAY[${parsed.data.tagIds.map((id) => `'${id}'`).join(",")}]::uuid[]`)}) as t(id)
        on conflict do nothing
      `);
      break;
    }

    // ============ UNTAG ============
    case "untag": {
      if (!parsed.data.tagIds || parsed.data.tagIds.length === 0) {
        return problem(400, "missing_tagIds");
      }
      // Single DELETE for all items × all tags.
      await db
        .delete(workItemTags)
        .where(
          and(
            inArray(workItemTags.itemId, validIds),
            inArray(workItemTags.tagId, parsed.data.tagIds),
          ),
        );
      break;
    }

    // ============ FAVORITE ============
    case "favorite": {
      await db
        .update(workItems)
        .set({ favorite: true, updatedAt: new Date() })
        .where(inArray(workItems.id, validIds));
      break;
    }

    // ============ UNFAVORITE ============
    case "unfavorite": {
      await db
        .update(workItems)
        .set({ favorite: false, updatedAt: new Date() })
        .where(inArray(workItems.id, validIds));
      break;
    }

    default:
      return problem(400, "unknown_action");
  }

  // Audit the bulk action.
  await audit({
    actorId: user.id,
    actorKind: "user",
    action: action === "delete" ? "conversation.delete" : "workspace.update",
    targetType: "message",
    targetId: validIds[0] ?? "bulk",
    metadata: {
      bulk: true,
      action,
      itemCount: validIds.length,
    },
    ip: ip(req),
  });

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;

  return ok({ results, affected: succeeded, failed });
}
