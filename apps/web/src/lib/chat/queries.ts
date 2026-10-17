import { db } from "@supa/db";
import {
  conversations,
  messages,
  conversationFolders,
} from "@supa/db/schema";
import { eq, desc, and, or, sql } from "drizzle-orm";

export interface ConversationRow {
  id: string;
  workspaceId: string;
  userId: string;
  mode: string;
  title: string | null;
  titleAuto: boolean;
  languagePref: string | null;
  pinned: boolean;
  folderId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageRow {
  id: string;
  conversationId: string;
  parentMessageId: string | null;
  role: "user" | "assistant" | "system";
  content: string;
  version: number;
  languageDetected: string | null;
  promptVersion: string | null;
  status: "streaming" | "completed" | "aborted" | "error" | "refused";
  createdAt: Date;
}

/**
 * Returns the conversation row if the caller owns it or is a workspace member.
 * Throws "not_found" if the conversation doesn't exist.
 * Throws "forbidden" if the caller lacks access.
 *
 * NOTE: this function uses the service-role client (bypasses RLS) because
 * the caller is already authenticated by `requireUser()`. RLS would
 * also work, but service-role is faster and avoids the per-request
 * cookie-binding overhead.
 */
export async function getConversation(
  conversationId: string,
  userId: string,
): Promise<ConversationRow> {
  const rows = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  const conv = rows[0];
  if (!conv) throw new Error("not_found");
  if (conv.userId !== userId) {
    // Check workspace membership via the DB function (same one RLS uses).
    // Use parameterized SQL — never string-interpolate user-controlled values.
    const memberRows = await db.execute(
      sql`SELECT public.is_workspace_member(${conv.workspaceId}::uuid) AS is_member`,
    );
    const isMember = (memberRows[0] as { is_member?: boolean } | undefined)?.is_member;
    if (!isMember) throw new Error("forbidden");
  }
  return {
    id: conv.id,
    workspaceId: conv.workspaceId,
    userId: conv.userId,
    mode: conv.mode,
    title: conv.title,
    titleAuto: conv.titleAuto,
    languagePref: conv.languagePref,
    pinned: conv.pinned,
    folderId: conv.folderId,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
  };
}

/**
 * Returns recent messages for a conversation, ordered oldest-first so the
 * LLM receives them in chronological order.
 *
 * @param limit  Max messages to return (default 50). Older messages are
 *                truncated — the caller can implement pagination if needed.
 */
export async function getMessages(
  conversationId: string,
  limit = 50,
): Promise<MessageRow[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(limit);
  return rows.reverse().map((r) => ({
    id: r.id,
    conversationId: r.conversationId,
    parentMessageId: r.parentMessageId,
    role: r.role as MessageRow["role"],
    content: r.content,
    version: r.version,
    languageDetected: r.languageDetected,
    promptVersion: r.promptVersion,
    status: r.status as MessageRow["status"],
    createdAt: r.createdAt,
  }));
}

/**
 * Lists conversations for the caller, newest-first.
 * Optional filters: pinned-only, folder.
 */
export async function listConversations(
  userId: string,
  opts?: { pinnedOnly?: boolean; folderId?: string | null },
): Promise<ConversationRow[]> {
  const conditions = [eq(conversations.userId, userId)];
  if (opts?.pinnedOnly) conditions.push(eq(conversations.pinned, true));
  if (opts?.folderId !== undefined) {
    // folderId can be string | null; Drizzle's eq() accepts string | null for nullable columns.
    conditions.push(eq(conversations.folderId, opts.folderId as string) as never);
  }

  const rows = await db
    .select()
    .from(conversations)
    .where(and(...conditions))
    .orderBy(desc(conversations.updatedAt))
    .limit(100);

  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspaceId,
    userId: r.userId,
    mode: r.mode,
    title: r.title,
    titleAuto: r.titleAuto,
    languagePref: r.languagePref,
    pinned: r.pinned,
    folderId: r.folderId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

/**
 * Creates a new conversation. Returns the row.
 */
export async function createConversation(input: {
  workspaceId: string;
  userId: string;
  mode: string;
  title?: string | null;
  languagePref?: string | null;
  folderId?: string | null;
}): Promise<ConversationRow> {
  const [inserted] = await db
    .insert(conversations)
    .values({
      workspaceId: input.workspaceId,
      userId: input.userId,
      mode: input.mode,
      title: input.title ?? null,
      titleAuto: input.title === undefined || input.title === null,
      languagePref: input.languagePref ?? null,
      folderId: input.folderId ?? null,
    })
    .returning();
  if (!inserted) throw new Error("insert_failed");
  return {
    id: inserted.id,
    workspaceId: inserted.workspaceId,
    userId: inserted.userId,
    mode: inserted.mode,
    title: inserted.title,
    titleAuto: inserted.titleAuto,
    languagePref: inserted.languagePref,
    pinned: inserted.pinned,
    folderId: inserted.folderId,
    createdAt: inserted.createdAt,
    updatedAt: inserted.updatedAt,
  };
}

/**
 * Patches a conversation (title, pinned, folderId).
 * Ownership is enforced by RLS, but we also check here so we can
 * return a clean 403 instead of a silent no-op.
 */
export async function updateConversation(
  conversationId: string,
  userId: string,
  patch: { title?: string; pinned?: boolean; folderId?: string | null },
): Promise<ConversationRow> {
  // Verify ownership.
  const existing = await getConversation(conversationId, userId);
  if (existing.userId !== userId) throw new Error("forbidden");

  const updateSet: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.title !== undefined) {
    updateSet.title = patch.title;
    updateSet.titleAuto = false;
  }
  if (patch.pinned !== undefined) updateSet.pinned = patch.pinned;
  if (patch.folderId !== undefined) updateSet.folderId = patch.folderId;

  const [updated] = await db
    .update(conversations)
    .set(updateSet)
    .where(eq(conversations.id, conversationId))
    .returning();
  if (!updated) throw new Error("update_failed");
  return {
    id: updated.id,
    workspaceId: updated.workspaceId,
    userId: updated.userId,
    mode: updated.mode,
    title: updated.title,
    titleAuto: updated.titleAuto,
    languagePref: updated.languagePref,
    pinned: updated.pinned,
    folderId: updated.folderId,
    createdAt: updated.createdAt,
    updatedAt: updated.updatedAt,
  };
}

/**
 * Deletes a conversation. RLS enforces ownership; we re-check here for
 * a clean 403.
 */
export async function deleteConversation(
  conversationId: string,
  userId: string,
): Promise<void> {
  const existing = await getConversation(conversationId, userId);
  if (existing.userId !== userId) throw new Error("forbidden");
  await db.delete(conversations).where(eq(conversations.id, conversationId));
}
