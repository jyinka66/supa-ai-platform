import { supabaseServer } from "@/lib/supabase/server";

export interface PersistMessageInput {
  conversationId: string;
  /** Existing message this message replies to. */
  parentId: string | null;
  /** Stable client-generated UUID used to deduplicate user-message retries. */
  messageId?: string;
  role: "user" | "assistant" | "system";
  content: string;
  provider: string;
  model: string;
  status: "streaming" | "completed" | "aborted" | "error" | "refused";
  firstTokenMs: number | null;
  totalMs: number;
  fallbackPath: string[];
  idempotencyKey?: string;
  promptVersion?: string;
  requestId?: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
}

/**
 * Persists a chat message with the caller's Supabase session, so database
 * row-level security remains active. Provider/usage metadata is only written
 * for assistant/system records; user messages are not AI-provider calls.
 */
export async function persistMessage(input: PersistMessageInput): Promise<string> {
  const supabase = await supabaseServer();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) throw new Error("unauthenticated");

  // Retry requests reuse the optimistic user-message UUID so a failed answer
  // can be retried without creating a second copy of the same user message.
  if (input.role === "user" && input.messageId) {
    const { data: existing, error } = await supabase
      .from("messages")
      .select("id, conversation_id, role, content")
      .eq("id", input.messageId)
      .maybeSingle();

    if (error) throw error;
    if (existing) {
      if (
        existing.conversation_id !== input.conversationId ||
        existing.role !== "user" ||
        existing.content !== input.content
      ) {
        throw new Error("message_id_conflict");
      }
      return existing.id as string;
    }
  }

  // Idempotency applies to generated messages, which have a message_meta row.
  if (input.role !== "user" && input.idempotencyKey) {
    const { data: existing, error } = await supabase
      .from("message_meta")
      .select("message_id")
      .eq("idempotency_key", input.idempotencyKey)
      .maybeSingle();
    if (error) throw error;
    if (existing?.message_id) return existing.message_id as string;
  }

  const insertValues: Record<string, unknown> = {
    conversation_id: input.conversationId,
    parent_message_id: input.parentId,
    role: input.role,
    content: input.content,
    status: input.status,
    prompt_version: input.promptVersion ?? null,
  };
  if (input.role === "user" && input.messageId) {
    insertValues.id = input.messageId;
  }

  const { data: inserted, error: insertError } = await supabase
    .from("messages")
    .insert(insertValues)
    .select("id")
    .single();

  if (insertError) {
    // If a client retry raced with the first insert, reuse the row only after
    // validating that the UUID already belongs to this exact user message.
    if (input.role === "user" && input.messageId && insertError.code === "23505") {
      const { data: raced, error } = await supabase
        .from("messages")
        .select("id, conversation_id, role, content")
        .eq("id", input.messageId)
        .maybeSingle();
      if (
        !error &&
        raced &&
        raced.conversation_id === input.conversationId &&
        raced.role === "user" &&
        raced.content === input.content
      ) {
        return raced.id as string;
      }
    }
    throw insertError;
  }

  const messageId = inserted.id as string;

  // User messages deliberately do not create message_meta records: provider
  // metadata is meaningful only for model output, and has strict provider IDs.
  if (input.role !== "user") {
    const { error: metaError } = await supabase.from("message_meta").insert({
      message_id: messageId,
      model: input.model,
      provider: input.provider,
      input_tokens: input.inputTokens ?? null,
      output_tokens: input.outputTokens ?? null,
      cost_usd: input.costUsd ?? null,
      latency_first_token_ms: input.firstTokenMs,
      latency_total_ms: input.totalMs,
      retries: input.fallbackPath.length,
      fallback_path: input.fallbackPath,
      idempotency_key: input.idempotencyKey ?? null,
      request_id: input.requestId ?? null,
    });

    if (metaError) {
      if (input.idempotencyKey && metaError.code === "23505") {
        const { data: existing } = await supabase
          .from("message_meta")
          .select("message_id")
          .eq("idempotency_key", input.idempotencyKey)
          .maybeSingle();

        await supabase.from("messages").delete().eq("id", messageId);
        if (existing?.message_id) return existing.message_id as string;
      } else {
        await supabase.from("messages").delete().eq("id", messageId);
      }
      throw metaError;
    }
  }

  // Keep recent conversation ordering up to date. A failure to update this
  // denormalized timestamp must not discard a response that was saved.
  const { error: touchError } = await supabase
    .from("conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", input.conversationId);
  if (touchError) {
    console.warn("[chat] conversation activity timestamp update failed", {
      code: touchError.code,
      message: touchError.message,
    });
  }

  return messageId;
}
