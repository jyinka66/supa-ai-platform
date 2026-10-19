import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@supa/db";
import {
  workItems,
  workItemVersions,
  workItemTags,
  workItemLinks,
  workItemShares,
  tags,
  shareLinks,
} from "@supa/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { requireUser } from "@/lib/auth/session";
import { guard } from "@/lib/ratelimit/guard";
import { problem, ok } from "@/lib/api/problem";
import { audit } from "@/lib/audit";
import { ip } from "@/lib/utils/ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PatchBody = z.object({
  title: z.string().min(1).max(200).optional(),
  content: z.string().max(1_000_000).optional(),
  contentFormat: z.enum(["markdown", "html", "json", "code", "none"]).optional(),
  metadata: z.record(z.unknown()).optional(),
  folderId: z.string().uuid().nullable().optional(),
  favorite: z.boolean().optional(),
  status: z.enum(["active", "trash"]).optional(),
  visibility: z.enum(["private", "workspace", "link"]).optional(),
}).strict();

interface ItemResponse {
  item: {
    id: string;
    title: string;
    type: string;
    content: string | null;
    contentFormat: string | null;
    fileUrl: string | null;
    fileSize: number | null;
    fileMime: string | null;
    thumbnailUrl: string | null;
    metadata: Record<string, unknown>;
    folderId: string | null;
    favorite: boolean;
    visibility: string;
    sourceType: string | null;
    sourceId: string | null;
    currentVersion: number;
    ownerId: string;
    createdAt: Date;
    updatedAt: Date;
    tags: Array<{ id: string; name: string }>;
    links: Array<{ toItemId: string; kind: string }>;
  };
  preview: {
    snippet: string | null;
    thumbnailUrl: string | null;
    /** Type-specific preview data (e.g. code language, image dimensions). */
    typeMeta: Record<string, unknown>;
  };
  versions: {
    latest: number;
    canRestore: boolean;
    history: Array<{ version: number; createdAt: Date; editedBy: string | null }>;
  };
  shareInfo: {
    activeLinks: number;
    sharedWithUsers: number;
    visibility: string;
  };
}

/**
 * GET /api/work/items/:id
 *
 * Returns a single work item with full context for the "open" view.
 *
 * Response shape (designed for <500ms):
 *   {
 *     item: { id, title, type, content|fileUrl, tags[], folderId, ... },
 *     preview: { snippet, thumbnailUrl, typeMeta },
 *     versions: { latest, canRestore, history },
 *     shareInfo: { activeLinks, sharedWithUsers, visibility }
 *   }
 *
 * The response is type-aware — preview.typeMeta varies by item type:
 *   - code: { language, lineCount }
 *   - image: { width, height, altText }
 *   - invoice: { total, currency, dueDate }
 *   - document: { wordCount, readingTime }
 *
 * All data is fetched in parallel (4 queries) to minimize latency.
 * RLS enforces access (owner / shared / workspace-visible).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await guard(req, "default");
  if (denied) return denied;

  const user = await requireUser();
  const { id } = await params;

  // Fetch the item + related data in parallel (4 queries).
  const [itemRows, tagRows, versionRows, shareRows] = await Promise.all([
    // 1. The item itself.
    db
      .select()
      .from(workItems)
      .where(eq(workItems.id, id))
      .limit(1),

    // 2. Tags (joined with tag names).
    db
      .select({
        id: tags.id,
        name: tags.name,
      })
      .from(workItemTags)
      .innerJoin(tags, eq(tags.id, workItemTags.tagId))
      .where(eq(workItemTags.itemId, id)),

    // 3. Version history (latest 10).
    db
      .select({
        version: workItemVersions.version,
        createdAt: workItemVersions.createdAt,
        editedBy: workItemVersions.editedBy,
      })
      .from(workItemVersions)
      .where(eq(workItemVersions.itemId, id))
      .orderBy(sql`${workItemVersions.version} desc`)
      .limit(10),

    // 4. Share info — count active link shares + user shares.
    Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(shareLinks)
        .where(
          and(
            eq(shareLinks.conversationId, id), // NOTE: share_links is keyed by conversation_id;
                                                // for work items we'd need a separate share_links
                                                // table or a polymorphic FK. For now, count from
                                                // work_item_shares instead.
          ),
        ),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(workItemShares)
        .where(eq(workItemShares.itemId, id)),
    ]).then(([linkCount, userCount]) => ({
      activeLinks: 0, // work items don't have link shares yet (future)
      sharedWithUsers: userCount[0]?.count ?? 0,
    })),
  ]);

  const item = itemRows[0];
  if (!item) {
    return problem(404, "not_found");
  }

  // Fetch cross-module links (backlinks).
  const linkRows = await db
    .select({
      toItemId: workItemLinks.toItemId,
      kind: workItemLinks.kind,
    })
    .from(workItemLinks)
    .where(eq(workItemLinks.fromItemId, id))
    .limit(20);

  // Build the preview (type-specific).
  const preview = buildPreview(item);

  // Build the version info.
  const latestVersion = item.currentVersion;
  const canRestore = versionRows.length > 1 && versionRows[0]!.version === latestVersion;

  // Record the view (fire-and-forget, for "Recently Viewed").
  void db
    .execute(sql`select public.upsert_work_item_view(${user.id}::uuid, ${id}::uuid)`)
    .catch(() => {});

  const response: ItemResponse = {
    item: {
      id: item.id,
      title: item.title,
      type: item.type,
      content: item.content,
      contentFormat: item.contentFormat,
      fileUrl: item.fileUrl,
      fileSize: item.fileSize,
      fileMime: item.fileMime,
      thumbnailUrl: item.thumbnailUrl,
      metadata: item.metadata as Record<string, unknown>,
      folderId: item.folderId,
      favorite: item.favorite,
      visibility: item.visibility,
      sourceType: item.sourceType,
      sourceId: item.sourceId,
      currentVersion: item.currentVersion,
      ownerId: item.ownerId,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      tags: tagRows,
      links: linkRows,
    },
    preview,
    versions: {
      latest: latestVersion,
      canRestore,
      history: versionRows,
    },
    shareInfo: {
      activeLinks: shareRows.activeLinks,
      sharedWithUsers: shareRows.sharedWithUsers,
      visibility: item.visibility,
    },
  };

  return ok(response);
}

/**
 * Builds a type-specific preview for the item.
 *
 * For text items: snippet (first 240 chars of content).
 * For file items: thumbnail URL + file metadata.
 * For code: language + line count.
 * For invoices: total + currency + due date (from metadata).
 */
function buildPreview(item: typeof workItems.$inferSelect): {
  snippet: string | null;
  thumbnailUrl: string | null;
  typeMeta: Record<string, unknown>;
} {
  const snippet = item.content
    ? item.content.slice(0, 240) + (item.content.length > 240 ? "..." : "")
    : null;

  const typeMeta: Record<string, unknown> = {};

  switch (item.type) {
    case "code":
      typeMeta.language = (item.metadata as { language?: string })?.language ?? "text";
      typeMeta.lineCount = item.content ? item.content.split("\n").length : 0;
      break;
    case "image":
      typeMeta.width = (item.metadata as { width?: number })?.width ?? null;
      typeMeta.height = (item.metadata as { height?: number })?.height ?? null;
      typeMeta.altText = (item.metadata as { altText?: string })?.altText ?? null;
      break;
    case "invoice":
      typeMeta.total = (item.metadata as { total?: number })?.total ?? null;
      typeMeta.currency = (item.metadata as { currency?: string })?.currency ?? "USD";
      typeMeta.dueDate = (item.metadata as { dueDate?: string })?.dueDate ?? null;
      break;
    case "document":
      typeMeta.wordCount = item.content ? item.content.split(/\s+/).length : 0;
      typeMeta.readingTime = item.content
        ? Math.ceil(item.content.split(/\s+/).length / 200) // ~200 wpm
        : 0;
      break;
    case "chat_reply":
    case "agent_output":
      typeMeta.tokenCount = (item.metadata as { tokenCount?: number })?.tokenCount ?? null;
      typeMeta.model = (item.metadata as { model?: string })?.model ?? null;
      break;
  }

  return {
    snippet,
    thumbnailUrl: item.thumbnailUrl,
    typeMeta,
  };
}

/**
 * PATCH /api/work/items/:id
 *
 * Updates a work item. If content/title changes, creates a new version row.
 * RLS enforces that only the owner (or a shared editor) can update.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await guard(req, "default");
  if (denied) return denied;

  const user = await requireUser();
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return problem(400, "invalid_json");
  }
  const parsed = PatchBody.safeParse(body);
  if (!parsed.success) {
    return problem(400, "invalid_request", parsed.error.issues[0]?.message);
  }

  // Fetch the current item to verify access + get the current version.
  const existing = await db
    .select()
    .from(workItems)
    .where(eq(workItems.id, id))
    .limit(1);

  const item = existing[0];
  if (!item) {
    return problem(404, "not_found");
  }

  // Check ownership (defense in depth — RLS also enforces this).
  if (item.ownerId !== user.id) {
    return problem(403, "forbidden");
  }

  // If content or title changed, create a new version row.
  const contentChanged =
    parsed.data.content !== undefined && parsed.data.content !== item.content;
  const titleChanged =
    parsed.data.title !== undefined && parsed.data.title !== item.title;

  if (contentChanged || titleChanged) {
    const newVersion = item.currentVersion + 1;
    await db.insert(workItemVersions).values({
      itemId: id,
      version: newVersion,
      title: parsed.data.title ?? item.title,
      content: parsed.data.content ?? item.content,
      contentFormat: parsed.data.contentFormat ?? item.contentFormat,
      metadata: parsed.data.metadata ?? item.metadata,
      fileUrl: item.fileUrl,
      editedBy: user.id,
    } as never);

    // Update current_version on the item.
    parsed.data.metadata = {
      ...(parsed.data.metadata ?? item.metadata as Record<string, unknown>),
      currentVersion: newVersion,
    };
  }

  // Build the update set (only non-undefined fields).
  const updateSet: Record<string, unknown> = { updatedAt: new Date() };
  if (parsed.data.title !== undefined) updateSet.title = parsed.data.title;
  if (parsed.data.content !== undefined) updateSet.content = parsed.data.content;
  if (parsed.data.contentFormat !== undefined) updateSet.contentFormat = parsed.data.contentFormat;
  if (parsed.data.metadata !== undefined) updateSet.metadata = parsed.data.metadata;
  if (parsed.data.folderId !== undefined) updateSet.folderId = parsed.data.folderId;
  if (parsed.data.favorite !== undefined) updateSet.favorite = parsed.data.favorite;
  if (parsed.data.status !== undefined) {
    updateSet.status = parsed.data.status;
    updateSet.trashedAt = parsed.data.status === "trash" ? new Date() : null;
    updateSet.trashedBy = parsed.data.status === "trash" ? user.id : null;
  }
  if (parsed.data.visibility !== undefined) updateSet.visibility = parsed.data.visibility;

  const [updated] = await db
    .update(workItems)
    .set(updateSet)
    .where(eq(workItems.id, id))
    .returning();

  if (!updated) {
    return problem(500, "update_failed");
  }

  // Audit the update.
  await audit({
    actorId: user.id,
    actorKind: "user",
    action: parsed.data.status === "trash" ? "conversation.delete" : "workspace.update",
    targetType: "message",
    targetId: id,
    metadata: {
      changedFields: Object.keys(parsed.data),
    },
    ip: ip(req),
  });

  return ok(updated);
}

/**
 * DELETE /api/work/items/:id
 *
 * Hard-deletes a work item. Only the owner can delete.
 * Soft-delete (trash) is done via PATCH with status='trash'.
 *
 * Cascades to: work_item_tags, work_item_versions, work_item_links, work_item_shares.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await guard(req, "default");
  if (denied) return denied;

  const user = await requireUser();
  const { id } = await params;

  // Verify ownership.
  const existing = await db
    .select({ id: workItems.id, ownerId: workItems.ownerId })
    .from(workItems)
    .where(eq(workItems.id, id))
    .limit(1);

  if (!existing[0]) {
    return problem(404, "not_found");
  }
  if (existing[0].ownerId !== user.id) {
    return problem(403, "forbidden");
  }

  await db.delete(workItems).where(eq(workItems.id, id));

  await audit({
    actorId: user.id,
    actorKind: "user",
    action: "conversation.delete",
    targetType: "message",
    targetId: id,
    ip: ip(req),
  });

  return ok({ id, deleted: true });
}
