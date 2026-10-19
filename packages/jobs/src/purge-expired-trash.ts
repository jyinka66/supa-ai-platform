import { db } from "@supa/db";
import { workItems } from "@supa/db/schema";
import { sql } from "drizzle-orm";
import { createClient } from "@supabase/supabase-js";
import pino from "pino";

const log = pino({ name: "purge_trash" }).child({ job: "purge_expired_trash" });

const RETENTION_DAYS = 30;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

const supabaseAdmin = createClient(url, serviceKey, {
  auth: { persistSession: false },
});

export interface PurgeTrashResult {
  purgedCount: number;
  fileErrors: number;
  purged: Array<{ id: string; title: string; workspaceId: string }>;
}

/**
 * Hard-deletes work items that have been in trash for longer than the
 * retention period (30 days by default).
 *
 * For each purged item:
 *   1. Delete associated files from Supabase Storage
 *   2. Hard-delete the item (cascades to versions, tags, links, shares, views)
 *
 * Idempotent — safe to re-run. Items already purged won't appear in the
 * next run.
 */
export async function purgeExpiredTrash(): Promise<PurgeTrashResult> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  // Fetch expired trash items (with file URLs for cleanup).
  const expired = await db
    .select({
      id: workItems.id,
      title: workItems.title,
      workspaceId: workItems.workspaceId,
      fileUrl: workItems.fileUrl,
      thumbnailUrl: workItems.thumbnailUrl,
    })
    .from(workItems)
    .where(
      sql`${workItems.status} = 'trash' and ${workItems.trashedAt} < ${cutoff}`,
    );

  if (expired.length === 0) {
    log.info({ event: "purge_trash_noop", count: 0 });
    return { purgedCount: 0, fileErrors: 0, purged: [] };
  }

  log.info({ event: "purge_trash_start", count: expired.length, cutoff: cutoff.toISOString() });

  let fileErrors = 0;

  // Delete associated files from storage (best-effort — don't block on failures).
  for (const item of expired) {
    const filesToDelete = [item.fileUrl, item.thumbnailUrl].filter(
      (f): f is string => f !== null,
    );

    for (const filePath of filesToDelete) {
      try {
        // Supabase Storage delete — removes the file from the bucket.
        // The path is relative to the bucket root.
        const { error } = await supabaseAdmin.storage
          .from("work-items")
          .remove([filePath]);

        if (error) {
          log.warn({
            event: "file_delete_failed",
            item_id: item.id,
            file_path: filePath,
            error: error.message,
          });
          fileErrors++;
        }
      } catch (err) {
        log.warn({
          event: "file_delete_error",
          item_id: item.id,
          file_path: filePath,
          error: String(err),
        });
        fileErrors++;
      }
    }
  }

  // Hard-delete the items (cascades to work_item_versions, work_item_tags,
  // work_item_links, work_item_shares, work_item_views).
  const ids = expired.map((e) => e.id);
  await db.execute(
    sql`delete from work_items where id = any(${sql.raw(`ARRAY[${ids.map((id) => `'${id}'`).join(",")}]::uuid[]`)})`,
  );

  log.info({
    event: "purge_trash_complete",
    purged: expired.length,
    file_errors: fileErrors,
  });

  return {
    purgedCount: expired.length,
    fileErrors,
    purged: expired.map((e) => ({
      id: e.id,
      title: e.title,
      workspaceId: e.workspaceId,
    })),
  };
}
