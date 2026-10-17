import { db } from "@supa/db";
import {
  workItems,
  workItemTags,
  tags,
  workFolders,
} from "@supa/db/schema";
import { eq, and } from "drizzle-orm";
import type { User } from "@supabase/supabase-js";
import { pino } from "@/lib/observability/logger";

const log = pino.child({ module: "work.capture" });

/**
 * The ONLY way anything enters "My Work".
 *
 * Every module (chat, agent runs, invoices, uploads, designs) calls this
 * function instead of writing to `work_items` directly. This ensures:
 *   - Consistent title generation
 *   - Auto-tagging by source module
 *   - Post-processing (thumbnails, embeddings, AI tag suggestions)
 *   - Audit trail
 *
 * The function is transactional: the work_item + its initial tags are
 * inserted atomically. Post-processing is fire-and-forget (the caller
 * doesn't wait for thumbnails/embeddings).
 */

export type WorkItemType =
  | "chat_reply"
  | "tool_output"
  | "design"
  | "invoice"
  | "proposal"
  | "plan"
  | "translation"
  | "code"
  | "image"
  | "document"
  | "agent_output"
  | "upload";

export type ContentFormat = "markdown" | "html" | "json" | "code" | "none";

export type SourceType =
  | "conversation"
  | "agent_run"
  | "invoice_run"
  | "upload"
  | "design_editor"
  | "manual"
  | null;

export interface CaptureInput {
  workspaceId: string;
  userId: string;
  type: WorkItemType;
  title?: string;
  content?: string;
  contentFormat?: ContentFormat;
  fileUrl?: string;
  fileSize?: number;
  fileMime?: string;
  thumbnailUrl?: string;
  metadata?: Record<string, unknown>;
  folderId?: string;
  sourceType?: SourceType;
  sourceId?: string;
}

/**
 * Captures a work item — the single entry point for all content.
 *
 * @example
 *   // From the chat route (after streaming completes):
 *   await captureWorkItem({
 *     workspaceId: ws.id,
 *     userId: user.id,
 *     type: "chat_reply",
 *     content: assistantMessage,
 *     contentFormat: "markdown",
 *     sourceType: "conversation",
 *     sourceId: conversationId,
 *   });
 */
export async function captureWorkItem(input: CaptureInput): Promise<typeof workItems.$inferSelect> {
  // Resolve defaults BEFORE the transaction (don't block on I/O inside).
  const title = input.title ?? defaultTitle(input.type, input.content);
  const folderId = input.folderId ?? (await defaultFolderFor(input.type, input.workspaceId, input.userId));
  const sourceTag = input.sourceType ? tagForSource(input.sourceType) : null;

  // Insert the item + initial tags in a single transaction.
  const item = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(workItems)
      .values({
        workspaceId: input.workspaceId,
        ownerId: input.userId,
        title,
        type: input.type,
        content: input.content ?? null,
        contentFormat: input.contentFormat ?? "markdown",
        fileUrl: input.fileUrl ?? null,
        fileSize: input.fileSize ?? null,
        fileMime: input.fileMime ?? null,
        thumbnailUrl: input.thumbnailUrl ?? null,
        metadata: input.metadata ?? {},
        folderId: folderId ?? null,
        sourceType: input.sourceType ?? null,
        sourceId: input.sourceId ?? null,
        status: "active",
        visibility: "private",
      })
      .returning();

    if (!row) throw new Error("work_item_insert_failed");

    // Auto-tag with the source module (e.g. "conversation", "upload").
    if (sourceTag) {
      const tagId = await ensureTag(tx, input.workspaceId, sourceTag);
      if (tagId) {
        await tx.insert(workItemTags).values({
          itemId: row.id,
          tagId,
        }).onConflictDoNothing(); // idempotent if the tag already exists
      }
    }

    return row;
  });

  // Fire-and-forget post-processing — the caller doesn't wait.
  void enqueueItemPostProcessing(item.id, input).catch((err) => {
    log.warn({
      event: "work_item_post_processing_failed",
      item_id: item.id,
      error: String(err),
    });
  });

  log.info({
    event: "work_item_captured",
    item_id: item.id,
    type: input.type,
    source: input.sourceType,
  });

  return item;
}

/**
 * Generates a default title based on the item type + content.
 *
 * @example
 *   defaultTitle("chat_reply", "Hello world...") // → "Hello world"
 *   defaultTitle("code", "function foo() { ... }") // → "Code snippet"
 *   defaultTitle("upload", undefined) // → "Uploaded file"
 */
function defaultTitle(type: WorkItemType, content?: string): string {
  if (content) {
    // Use the first line of content, truncated to 60 chars.
    const firstLine = content.split("\n")[0]?.trim() ?? "";
    if (firstLine.length > 0) {
      return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
    }
  }

  const defaults: Record<WorkItemType, string> = {
    chat_reply: "Chat reply",
    tool_output: "Tool output",
    design: "Untitled design",
    invoice: "Invoice",
    proposal: "Untitled proposal",
    plan: "Untitled plan",
    translation: "Translation",
    code: "Code snippet",
    image: "Image",
    document: "Untitled document",
    agent_output: "Agent output",
    upload: "Uploaded file",
  };
  return defaults[type] ?? "Untitled";
}

/**
 * Returns the default folder ID for a given item type.
 *
 * Creates the folder if it doesn't exist (e.g. "Chat replies", "Code snippets").
 * Returns null if folder creation fails (the item will be root-level).
 */
async function defaultFolderFor(
  type: WorkItemType,
  workspaceId: string,
  userId: string,
): Promise<string | null> {
  const folderNames: Partial<Record<WorkItemType, string>> = {
    chat_reply: "Chat replies",
    code: "Code snippets",
    image: "Images",
    document: "Documents",
    upload: "Uploads",
    invoice: "Invoices",
    proposal: "Proposals",
    plan: "Plans",
  };

  const folderName = folderNames[type];
  if (!folderName) return null;

  try {
    // Check if the folder already exists.
    const existing = await db
      .select({ id: workFolders.id })
      .from(workFolders)
      .where(
        and(
          eq(workFolders.workspaceId, workspaceId),
          eq(workFolders.name, folderName),
        ),
      )
      .limit(1);

    if (existing[0]) return existing[0].id;

    // Create the folder.
    const [created] = await db
      .insert(workFolders)
      .values({
        workspaceId,
        name: folderName,
        createdBy: userId,
        path: "", // populated by the trigger
      })
      .returning();

    return created?.id ?? null;
  } catch (err) {
    log.warn({
      event: "default_folder_create_failed",
      type,
      workspace_id: workspaceId,
      error: String(err),
    });
    return null;
  }
}

/**
 * Maps a source type to a tag name for auto-tagging.
 */
function tagForSource(source: SourceType): string | null {
  if (!source) return null;
  const tagMap: Record<string, string> = {
    conversation: "from-chat",
    agent_run: "from-agent",
    invoice_run: "from-invoice",
    upload: "uploaded",
    design_editor: "designed",
    manual: "manual",
  };
  return tagMap[source] ?? null;
}

/**
 * Ensures a tag exists in the workspace, creating it if needed.
 * Returns the tag ID, or null if creation failed.
 *
 * Uses upsert to handle concurrent creation (two callers might try to
 * create the same tag simultaneously — only one wins).
 */
async function ensureTag(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  workspaceId: string,
  name: string,
): Promise<string | null> {
  try {
    // Check if the tag already exists.
    const existing = await tx
      .select({ id: tags.id })
      .from(tags)
      .where(
        and(
          eq(tags.workspaceId, workspaceId),
          eq(tags.name, name),
        ),
      )
      .limit(1);

    if (existing[0]) return existing[0].id;

    // Create the tag.
    const [created] = await tx
      .insert(tags)
      .values({ workspaceId, name })
      .onConflictDoNothing() // handle race condition
      .returning();

    return created?.id ?? null;
  } catch (err) {
    log.warn({
      event: "tag_ensure_failed",
      workspace_id: workspaceId,
      tag_name: name,
      error: String(err),
    });
    return null;
  }
}

/**
 * Enqueues post-processing for a newly captured work item.
 *
 * This is fire-and-forget — the caller doesn't wait. The post-processing
 * includes:
 *   - Thumbnail generation (for images/PDFs)
 *   - Embedding generation (for semantic search)
 *   - AI tag suggestions (analyzes content, suggests additional tags)
 *   - Notifications (to workspace members if visibility='workspace')
 *
 * TODO: this currently runs inline. Production should push to a queue
 * (Upstash QStash, SQS, etc.) so post-processing doesn't block on the
 * event loop of the capturing request — fine for small workspaces, but
 * the thumbnail/embedding/tag jobs should be offloaded once volume grows.
 */
async function enqueueItemPostProcessing(
  itemId: string,
  input: CaptureInput,
): Promise<void> {
  // 1. Generate thumbnail for image/file items.
  if (input.fileUrl && !input.thumbnailUrl) {
    void generateThumbnail(itemId, input.fileUrl, input.fileMime).catch(() => {});
  }

  // 2. Generate embedding for semantic search.
  // No-ops when the AI service isn't configured (see generateEmbedding).
  void generateEmbedding(itemId, input.content).catch(() => {});

  // 3. AI tag suggestions.
  // No-ops when the AI service isn't configured (see suggestTags).
  void suggestTags(itemId, input.content, input.type).catch(() => {});

  log.debug({
    event: "work_item_post_processing_enqueued",
    item_id: itemId,
    has_thumbnail_job: !!input.fileUrl && !input.thumbnailUrl,
  });
}

/**
 * Generates a thumbnail for a file.
 *
 * For images, sets the work_item's thumbnailUrl to the file's URL directly
 * (cheap, correct for the common case — the source image *is* a valid
 * thumbnail). For PDFs and other formats, a real image-processing service
 * (sharp / ImageMagick / Cloudinary) should generate a rasterized preview;
 * that's a TODO until wired.
 */
async function generateThumbnail(
  itemId: string,
  fileUrl: string,
  fileMime: string | undefined,
): Promise<void> {
  // Only generate for images and PDFs.
  if (!fileMime?.startsWith("image/") && fileMime !== "application/pdf") return;

  try {
    if (fileMime?.startsWith("image/")) {
      // Images: the source URL is a valid thumbnail. Persist it so the
      // work list can render a preview without a second fetch+transform.
      await db
        .update(workItems)
        .set({ thumbnailUrl: fileUrl })
        .where(eq(workItems.id, itemId));
    }
    // TODO: for PDFs (and other non-image formats), call an image
    // processing service (sharp / ImageMagick / Cloudinary) to rasterize
    // the first page and upload the derived thumbnail. Until then, PDFs
    // get no thumbnailUrl — the UI falls back to a type-icon.

    log.info({
      event: "thumbnail_generated",
      item_id: itemId,
      file_mime: fileMime,
    });
  } catch (err) {
    log.warn({
      event: "thumbnail_generation_failed",
      item_id: itemId,
      error: String(err),
    });
  }
}

/**
 * Returns true if any LLM provider is configured. Used to gate AI
 * post-processing jobs so they no-op silently when the AI service isn't
 * wired (instead of crashing the fire-and-forget path).
 */
function isAiConfigured(): boolean {
  return Boolean(
    process.env.OPENROUTER_API_KEY ||
      process.env.GEMINI_API_KEY ||
      process.env.GROQ_API_KEY,
  );
}

/**
 * Generates an embedding for the item's content (semantic search).
 *
 * No-ops when no AI provider is configured. When one is, the actual
 * embeddings API call still needs wiring (TODO) — for now we log so the
 * signal is visible without spamming when AI is off.
 */
async function generateEmbedding(
  itemId: string,
  content: string | undefined,
): Promise<void> {
  if (!content) return;
  if (!isAiConfigured()) return; // no-op when AI service isn't configured

  // TODO: call the configured provider's embeddings endpoint and persist
  // the vector to the work_item_embeddings table. The provider env vars
  // above gate chat completion — a dedicated embeddings key (e.g.
  // OPENAI_API_KEY) may be needed depending on which provider is used.
  log.debug({
    event: "embedding_generation_skipped",
    item_id: itemId,
    reason: "embeddings_api_not_wired",
  });
}

/**
 * Runs AI tag suggestions on the item's content.
 *
 * No-ops when no AI provider is configured. When one is, the actual LLM
 * call still needs wiring (TODO).
 */
async function suggestTags(
  itemId: string,
  content: string | undefined,
  type: WorkItemType,
): Promise<void> {
  if (!content) return;
  if (!isAiConfigured()) return; // no-op when AI service isn't configured

  // TODO: prompt the configured LLM provider with the content + item type,
  // parse the suggested tags, and upsert them via ensureTag + workItemTags.
  // Until then, log so the signal is visible without spamming when AI is off.
  log.debug({
    event: "tag_suggestions_skipped",
    item_id: itemId,
    type,
    reason: "tag_suggestion_api_not_wired",
  });
}
