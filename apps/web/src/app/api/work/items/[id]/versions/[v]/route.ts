import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@supa/db";
import { workItemVersions, workItems } from "@supa/db/schema";
import { eq, and } from "drizzle-orm";
import { requireUser } from "@/lib/auth/session";
import { guard } from "@/lib/ratelimit/guard";
import { problem, ok } from "@/lib/api/problem";
import { audit } from "@/lib/audit";
import { ip } from "@/lib/utils/ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/work/items/:id/versions/:v
 *
 * Returns a full version snapshot (content, title, metadata, storage_key).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; v: string }> },
) {
  const denied = await guard(req, "default");
  if (denied) return denied;

  await requireUser();
  const { id, v } = await params;

  const versionNum = parseInt(v, 10);
  if (isNaN(versionNum) || versionNum < 1) {
    return problem(400, "invalid_version");
  }

  const rows = await db
    .select()
    .from(workItemVersions)
    .where(
      and(
        eq(workItemVersions.itemId, id),
        eq(workItemVersions.version, versionNum),
      ),
    )
    .limit(1);

  const snapshot = rows[0];
  if (!snapshot) {
    return problem(404, "version_not_found");
  }

  return ok({
    id: snapshot.id,
    itemId: snapshot.itemId,
    version: snapshot.version,
    title: snapshot.title,
    content: snapshot.content,
    contentFormat: snapshot.contentFormat,
    metadata: snapshot.metadata,
    source: snapshot.source,
    editedBy: snapshot.editedBy,
    createdAt: snapshot.createdAt,
  });
}

/**
 * POST /api/work/items/:id/versions/:v/restore
 *
 * Restores a work item to a previous version.
 *
 * Flow:
 *   1. Fetch the target version snapshot
 *   2. Update work_items with the snapshot's content/title/metadata
 *   3. Create a NEW version row (source='restore') so the history is linear
 *   4. Audit the restore
 *
 * The restore doesn't delete intermediate versions — they remain in the
 * history for full traceability.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; v: string }> },
) {
  const denied = await guard(req, "default");
  if (denied) return denied;

  const user = await requireUser();
  const { id, v } = await params;

  const versionNum = parseInt(v, 10);
  if (isNaN(versionNum) || versionNum < 1) {
    return problem(400, "invalid_version");
  }

  // 1. Fetch the target version snapshot.
  const snapshotRows = await db
    .select()
    .from(workItemVersions)
    .where(
      and(
        eq(workItemVersions.itemId, id),
        eq(workItemVersions.version, versionNum),
      ),
    )
    .limit(1);

  const snapshot = snapshotRows[0];
  if (!snapshot) {
    return problem(404, "version_not_found");
  }

  // Verify the caller owns the item.
  const itemRows = await db
    .select({ id: workItems.id, ownerId: workItems.ownerId })
    .from(workItems)
    .where(eq(workItems.id, id))
    .limit(1);

  if (!itemRows[0]) {
    return problem(404, "item_not_found");
  }
  if (itemRows[0].ownerId !== user.id) {
    return problem(403, "forbidden");
  }

  // 2. Update work_items with the snapshot's content.
  await db
    .update(workItems)
    .set({
      title: snapshot.title ?? "Untitled",
      content: snapshot.content,
      contentFormat: snapshot.contentFormat,
      metadata: snapshot.metadata ?? {},
      updatedAt: new Date(),
    })
    .where(eq(workItems.id, id));

  // 3. Create a new version row (source='restore').
  // The trigger will auto-assign the next version number.
  await db.insert(workItemVersions).values({
    itemId: id,
    version: 0, // trigger auto-assigns
    title: snapshot.title,
    content: snapshot.content,
    contentFormat: snapshot.contentFormat,
    metadata: snapshot.metadata,
    source: "restore",
    editedBy: user.id,
  });

  // 4. Audit.
  await audit({
    actorId: user.id,
    actorKind: "user",
    action: "workspace.update",
    targetType: "message",
    targetId: id,
    metadata: {
      restoredFromVersion: versionNum,
    },
    ip: ip(req),
  });

  return ok({
    restored: true,
    fromVersion: versionNum,
    item: {
      title: snapshot.title,
      content: snapshot.content,
      contentFormat: snapshot.contentFormat,
    },
  });
}
