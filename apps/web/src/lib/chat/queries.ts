import { supabaseServer } from "@/lib/supabase/server";

export type WorkspaceRole = "owner" | "admin" | "member" | "viewer";

export interface WorkspaceWithMembership {
  id: string;
  slug: string;
  name: string;
  logo_path: string | null;
  is_personal: boolean;
  plan: string;
  seat_limit: number;
  workspace_members: { role: WorkspaceRole }[];
}

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

type ConversationRecord = {
  id: string;
  workspace_id: string;
  user_id: string;
  mode: string;
  title: string | null;
  title_auto: boolean;
  language_pref: string | null;
  pinned: boolean;
  folder_id: string | null;
  created_at: string;
  updated_at: string;
};

type MessageRecord = {
  id: string;
  conversation_id: string;
  parent_message_id: string | null;
  role: "user" | "assistant" | "system";
  content: string;
  version: number;
  language_detected: string | null;
  prompt_version: string | null;
  status: MessageRow["status"];
  created_at: string;
};

const CONVERSATION_COLUMNS =
  "id, workspace_id, user_id, mode, title, title_auto, language_pref, pinned, folder_id, created_at, updated_at";
const MESSAGE_COLUMNS =
  "id, conversation_id, parent_message_id, role, content, version, language_detected, prompt_version, status, created_at";

function mapConversation(row: ConversationRecord): ConversationRow {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    mode: row.mode,
    title: row.title,
    titleAuto: row.title_auto,
    languagePref: row.language_pref,
    pinned: row.pinned,
    folderId: row.folder_id,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function mapMessage(row: MessageRecord): MessageRow {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    parentMessageId: row.parent_message_id,
    role: row.role,
    content: row.content,
    version: row.version,
    languageDetected: row.language_detected,
    promptVersion: row.prompt_version,
    status: row.status,
    createdAt: new Date(row.created_at),
  };
}

async function requireMatchingUser(userId: string): Promise<void> {
  const supabase = await supabaseServer();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user || user.id !== userId) throw new Error("forbidden");
}

/**
 * Fetches a conversation through Supabase's cookie-authenticated Data API.
 * Row-level security restricts results to the owner or a member of the
 * conversation's workspace; the caller identity is independently checked.
 */
export async function getConversation(
  conversationId: string,
  userId: string,
): Promise<ConversationRow> {
  await requireMatchingUser(userId);
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("conversations")
    .select(CONVERSATION_COLUMNS)
    .eq("id", conversationId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error("not_found");
  return mapConversation(data as unknown as ConversationRecord);
}

/**
 * Fetches recent messages through the authenticated Supabase Data API.
 * The table's RLS policies enforce access through the parent conversation.
 */
export async function getMessages(
  conversationId: string,
  limit = 50,
): Promise<MessageRow[]> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("messages")
    .select(MESSAGE_COLUMNS)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return ((data ?? []) as unknown as MessageRecord[])
    .reverse()
    .map(mapMessage);
}

/** Lists the current user's conversations, newest first. */
export async function listConversations(
  userId: string,
  opts?: { pinnedOnly?: boolean; folderId?: string | null },
): Promise<ConversationRow[]> {
  await requireMatchingUser(userId);
  const supabase = await supabaseServer();
  let query = supabase
    .from("conversations")
    .select(CONVERSATION_COLUMNS)
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(100);

  if (opts?.pinnedOnly) query = query.eq("pinned", true);
  if (opts?.folderId === null) query = query.is("folder_id", null);
  else if (typeof opts?.folderId === "string") query = query.eq("folder_id", opts.folderId);

  const { data, error } = await query;
  if (error) throw error;
  return ((data ?? []) as unknown as ConversationRecord[]).map(mapConversation);
}

/** Creates a conversation owned by the authenticated user. */
export async function createConversation(input: {
  workspaceId: string;
  userId: string;
  mode: string;
  title?: string | null;
  languagePref?: string | null;
  folderId?: string | null;
}): Promise<ConversationRow> {
  await requireMatchingUser(input.userId);
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("conversations")
    .insert({
      workspace_id: input.workspaceId,
      user_id: input.userId,
      mode: input.mode,
      title: input.title ?? null,
      title_auto: input.title === undefined || input.title === null,
      language_pref: input.languagePref ?? null,
      folder_id: input.folderId ?? null,
    })
    .select(CONVERSATION_COLUMNS)
    .single();

  if (error) throw error;
  return mapConversation(data as unknown as ConversationRecord);
}

/** Updates a conversation the current user owns. */
export async function updateConversation(
  conversationId: string,
  userId: string,
  patch: { title?: string; pinned?: boolean; folderId?: string | null },
): Promise<ConversationRow> {
  const existing = await getConversation(conversationId, userId);
  if (existing.userId !== userId) throw new Error("forbidden");

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.title !== undefined) {
    update.title = patch.title;
    update.title_auto = false;
  }
  if (patch.pinned !== undefined) update.pinned = patch.pinned;
  if (patch.folderId !== undefined) update.folder_id = patch.folderId;

  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("conversations")
    .update(update)
    .eq("id", conversationId)
    .select(CONVERSATION_COLUMNS)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error("update_failed");
  return mapConversation(data as unknown as ConversationRecord);
}

/** Deletes a conversation the current user owns. */
export async function deleteConversation(
  conversationId: string,
  userId: string,
): Promise<void> {
  const existing = await getConversation(conversationId, userId);
  if (existing.userId !== userId) throw new Error("forbidden");

  const supabase = await supabaseServer();
  const { error } = await supabase
    .from("conversations")
    .delete()
    .eq("id", conversationId);
  if (error) throw error;
}
