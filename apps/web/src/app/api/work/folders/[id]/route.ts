import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@supa/db";
import { workFolders, workItems } from "@supa/db/schema";
import { eq, and, isNull, sql } from "drizzle-orm";
import { requireUser } from "@/lib/auth/session";
import { guard } from "@/lib/ratelimit/guard";
import { problem, ok } from "@/lib/api/problem";
import { audit } from "@/lib/audit";
import { ip } from "@/lib/utils/ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PatchBody = z.object({
  name: z.string().min(1).max(100).optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).nullable().optional(),
  parentId: z.string().uuid().nullable().optional(), // move via parentId
  smartParams: z.record(z.unknown()).optional(), // update smart folder params
}).strict();

/**
 * PATCH /api/work/folders/:id
 *
 * Updates a folder. If `parentId` changes, the folder is moved (and its
 * subtree paths are rewritten via the `move_work_folder` RPC).
 *
 * If `name` changes, the `rename_work_folder` RPC checks for conflicts.
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

  // Verify the folder exists + is owned by the caller.
  const existing = await db
    .select()
    .from(workFolders)
    .where(eq(workFolders.id, id))
    .limit(1);

  const folder = existing[0];
  if (!folder) {
    return problem(404, "not_found");
  }
  if (folder.createdBy !== user.id) {
    return problem(403, "forbidden");
  }

  // Handle move (parentId changed).
  if (parsed.data.parentId !== undefined && parsed.data.parentId !== folder.parentId) {
    try {
      await db.execute(
        sql`select public.move_work_folder(${id}::uuid, ${parsed.data.parentId}::uuid, ${user.id}::uuid)`,
      );
    } catch (err) {
      const msg = String(err);
      if (msg.includes("cycle_detected")) return problem(400, "cycle_detected");
      if (msg.includes("parent_not_found")) return problem(404, "parent_not_found");
      if (msg.includes("cross_workspace")) return problem(403, "cross_workspace");
      return problem(500, "move_failed");
    }
  }

  // Handle rename.
  if (parsed.data.name !== undefined && parsed.data.name !== folder.name) {
    try {
      await db.execute(
        sql`select public.rename_work_folder(${id}::uuid, ${parsed.data.name}::text, ${user.id}::uuid)`,
      );
    } catch (err) {
      const msg = String(err);
      if (msg.includes("name_conflict")) return problem(409, "name_conflict");
      return problem(500, "rename_failed");
    }
  }

  // Handle simple field updates (color, smartParams).
  const updateSet: Record<string, unknown> = {};
  if (parsed.data.color !== undefined) updateSet.color = parsed.data.color;
  if (parsed.data.smartParams !== undefined) updateSet.smartParams = parsed.data.smartParams;

  if (Object.keys(updateSet).length > 0) {
    await db
      .update(workFolders)
      .set(updateSet)
      .where(eq(workFolders.id, id));
  }

  // Fetch the updated row.
  const [updated] = await db
    .select()
    .from(workFolders)
    .where(eq(workFolders.id, id))
    .limit(1);

  return ok(updated);
}

const DeleteSchema = z.object({
  strategy: z.enum(["move_to_root", "trash_children"]).default("move_to_root"),
});

/**
 * DELETE /api/work/folders/:id?strategy=move_to_root|trash_children
 *
 * Deletes a folder. Items inside are handled by the strategy:
 *   - move_to_root: items' folder_id is set to null (they become root-level)
 *   - trash_children: items are soft-deleted (status='trash')
 *
 * Child folders are handled the same way (recursively, via cascade or explicit update).
 *
 * Only the folder creator can delete it.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await guard(req, "default");
  if (denied) return denied;

  const user = await requireUser();
  const { id } = await params;

  // Parse strategy.
  const url = new URL(req.url);
  const parsed = DeleteSchema.safeParse({
    strategy: url.searchParams.get("strategy") ?? "move_to_root",
  });
  if (!parsed.success) {
    return problem(400, "invalid_strategy");
  }
  const { strategy } = parsed.data;

  // Verify ownership.
  const existing = await db
    .select()
    .from(workFolders)
    .where(eq(workFolders.id, id))
    .limit(1);

  const folder = existing[0];
  if (!folder) {
    return problem(404, "not_found");
  }
  if (folder.createdBy !== user.id) {
    return problem(403, "forbidden");
  }

  // Handle items in this folder.
  const itemsInFolder = await db
    .select({ id: workItems.id })
    .from(workItems)
    .where(eq(workItems.folderId, id));

  if (strategy === "move_to_root") {
    // Set folder_id to null on items (they become root-level).
    if (itemsInFolder.length > 0) {
      await db
        .update(workItems)
        .set({ folderId: null })
        .where(eq(workItems.folderId, id));
    }
  } else if (strategy === "trash_children") {
    // Soft-delete items (status='trash').
    if (itemsInFolder.length > 0) {
      await db
        .update(workItems)
        .set({ status: "trash", trashedAt: new Date() })
        .where(eq(workItems.folderId, id));
    }
  }

  // Delete the folder itself (cascades to child folders via FK on delete cascade).
  await db.delete(workFolders).where(eq(workFolders.id, id));

  await audit({
    actorId: user.id,
    actorKind: "user",
    action: "conversation.delete",
    targetType: "workspace",
    targetId: id,
    metadata: {
      strategy,
      itemCount: itemsInFolder.length,
    },
    ip: ip(req),
  });

  return ok({ id, deleted: true, strategy, itemsAffected: itemsInFolder.length });
}
