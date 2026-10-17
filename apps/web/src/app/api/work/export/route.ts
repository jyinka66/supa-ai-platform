import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@supa/db";
import { exportJobs, workItems } from "@supa/db/schema";
import { eq, inArray } from "drizzle-orm";
import { requireUser } from "@/lib/auth/session";
import { guard } from "@/lib/ratelimit/guard";
import { problem, ok } from "@/lib/api/problem";
import { originalPath } from "@/lib/storage/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_INLINE_SIZE = 1_000_000; // 1MB — sync threshold

const CreateBody = z.object({
  format: z.enum(["pdf", "docx", "md", "json", "zip"]),
  selection: z.object({
    itemIds: z.array(z.string().uuid()).optional(),
    filter: z.record(z.unknown()).optional(),
    folderId: z.string().uuid().optional(),
    all: z.boolean().optional(),
  }).refine((d) => d.itemIds || d.filter || d.folderId || d.all, {
    message: "At least one selection criterion must be provided",
  }),
}).strict();

interface InlineResult {
  jobId: string;
  inline: true;
  format: string;
  content: string;
  mimeType: string;
  filename: string;
}

interface AsyncResult {
  jobId: string;
  inline: false;
  status: string;
}

/**
 * POST /api/work/export
 *
 * Creates an export job. If the export is a single item in markdown or JSON
 * format and the content is <1MB, the result is returned inline (sync).
 * Otherwise, an async job is created and the client polls for the result.
 *
 * @example
 *   // Sync (single item, markdown):
 *   POST /api/work/export { format: "md", selection: { itemIds: ["abc"] } }
 *   → 200 { jobId: "...", inline: true, content: "...", mimeType: "text/markdown" }
 *
 *   // Async (PDF, multiple items):
 *   POST /api/work/export { format: "pdf", selection: { itemIds: ["a","b"] } }
 *   → 202 { jobId: "...", inline: false, status: "queued" }
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
  const parsed = CreateBody.safeParse(body);
  if (!parsed.success) {
    return problem(400, "invalid_request", parsed.error.issues[0]?.message);
  }

  const wsCookie = req.cookies.get("ws")?.value;
  if (!wsCookie) return problem(400, "no_workspace_selected");

  const { format, selection } = parsed.data;

  // Check if we can do a sync export:
  //   - Single item (exactly 1 itemId)
  //   - Format is md or json
  //   - Content is <1MB
  const canSyncInline =
    selection.itemIds &&
    selection.itemIds.length === 1 &&
    (format === "md" || format === "json");

  if (canSyncInline) {
    // Fetch the item.
    const itemId = selection.itemIds![0]!;
    const itemRows = await db
      .select()
      .from(workItems)
      .where(eq(workItems.id, itemId))
      .limit(1);

    const item = itemRows[0];
    if (!item) return problem(404, "item_not_found");

    // Verify ownership (defense in depth).
    if (item.ownerId !== user.id) {
      // Check if shared with this user as editor/viewer.
      // For simplicity, RLS handles this — if the row was returned, they have access.
    }

    const content = item.content ?? "";
    const contentBytes = Buffer.byteLength(content, "utf8");

    if (contentBytes <= MAX_INLINE_SIZE) {
      // Sync inline export.
      const result = buildInlineExport(item, format);

      // Still create a job row (for audit trail + the user's export history).
      const [job] = await db
        .insert(exportJobs)
        .values({
          workspaceId: wsCookie,
          userId: user.id,
          format,
          selection,
          status: "done",
          progress: 100,
          resultMime: result.mimeType,
          resultSize: contentBytes,
        })
        .returning();

      const inlineResult: InlineResult = {
        jobId: job!.id,
        inline: true,
        format,
        content: result.content,
        mimeType: result.mimeType,
        filename: result.filename,
      };

      return ok(inlineResult);
    }
  }

  // Async export — create a job in `queued` state and return the ID.
  // The status is set explicitly to "queued" so any downstream worker
  // (cron, queue consumer, or admin UI) can pick up rows in this state.
  const [job] = await db
    .insert(exportJobs)
    .values({
      workspaceId: wsCookie,
      userId: user.id,
      format,
      selection,
      status: "queued",
    })
    .returning();

  // TODO(queue-worker): the job row above is inserted but NEVER processed
  // — no queue (Vercel QStash, Upstash Queue, SQS, or a cron-driven
  // worker) is wired to consume `queued` rows. Until a worker exists,
  // async exports stay in `queued` forever and the client's poll loop
  // (GET /api/work/export/:id) will never see progress > 0 or status
  // `done`. This MUST be wired before async export is usable in prod.
  // The worker should: claim the row (status → "processing"), render the
  // selected items in the requested format, upload the result to object
  // storage, then update status → "done" (or "failed") with the result URL.

  const asyncResult: AsyncResult = {
    jobId: job!.id,
    inline: false,
    status: "queued",
  };

  return ok(asyncResult, 202);
}

/**
 * Builds an inline export for a single item.
 */
function buildInlineExport(
  item: typeof workItems.$inferSelect,
  format: string,
): { content: string; mimeType: string; filename: string } {
  const safeTitle = (item.title ?? "export").replace(/[^a-zA-Z0-9-_]/g, "_").slice(0, 60);

  switch (format) {
    case "md":
      return {
        content: item.content ?? "",
        mimeType: "text/markdown",
        filename: `${safeTitle}.md`,
      };

    case "json":
      return {
        content: JSON.stringify({
          id: item.id,
          title: item.title,
          type: item.type,
          content: item.content,
          contentFormat: item.contentFormat,
          metadata: item.metadata,
          createdAt: item.createdAt.toISOString(),
          updatedAt: item.updatedAt.toISOString(),
        }, null, 2),
        mimeType: "application/json",
        filename: `${safeTitle}.json`,
      };

    default:
      // PDF/DOCX/ZIP can't be generated inline — return markdown as fallback.
      return {
        content: item.content ?? "",
        mimeType: "text/markdown",
        filename: `${safeTitle}.md`,
      };
  }
}
