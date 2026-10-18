import { supabaseServer } from "@/lib/supabase/server";

export interface PersistMessageInput {
  conversationId: string;
  parentId: string | null;
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
 * Saves a chat message via Supabase's authenticated Data API.
 *
 * All writes run with the signed-in user's JWT, so RLS remains in force.
 * Message and metadata writes are kept in sequence; on a metadata failure
 * the just-created message is cleaned up to avoid a partial record.
 */
export async function persistMessage(input: PersistMessageInput): Promise<string> {
  const supabase = await supabaseServer();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new Error("unauthenticated");

  if (input.idempotencyKey) {
    const { data: existing, error } = await supabase
      .from("message_meta")
      .select("message_id")
      .eq("idempotency_key", input.idempotencyKey)
      .maybeSingle();
    if (error) throw error;
    if (existing?.message_id) return existing.message_id as string;
  }

  const { data: inserted, error: insertError } = await supabase
    .from("messages")
    .insert({
      conversation_id: input.conversationId,
      parent_message_id: input.parentId,
      role: input.role,
      content: input.content,
      status: input.status,
      prompt_version: input.promptVersion ?? null,
    })
    .select("id")
    .single();

  if (insertError) throw insertError;
  const messageId = inserted.id as string;

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
    // If another in-flight attempt won the idempotency race, return its row
    // after removing this duplicate message.
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

  // Touch the conversation timestamp for reliable recent-activity ordering.
  const { error: touchError } = await supabase
    .from("conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", input.conversationId);

  if (touchError) throw touchError;
  return messageId;
}
