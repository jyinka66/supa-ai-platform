import { db } from "@supa/db";
import { messages, messageMeta, conversations } from "@supa/db/schema";
import { eq } from "drizzle-orm";

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
 * Inserts a message + its metadata in a single transaction.
 *
 * If `idempotencyKey` is provided and a row with that key already exists
 * in `message_meta`, returns the existing message id without inserting again.
 * This is the second line of defense against duplicate writes (the first
 * is the Redis idempotency key in the route handler).
 */
export async function persistMessage(input: PersistMessageInput): Promise<string> {
  // Idempotency check (best-effort).
  if (input.idempotencyKey) {
    const existing = await db
      .select({ messageId: messageMeta.messageId })
      .from(messageMeta)
      .where(eq(messageMeta.idempotencyKey, input.idempotencyKey))
      .limit(1);
    const existingRow = existing[0];
    if (existingRow?.messageId) {
      return existingRow.messageId;
    }
  }

  return await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(messages)
      .values({
        conversationId: input.conversationId,
        parentMessageId: input.parentId,
        role: input.role,
        content: input.content,
        status: input.status,
        promptVersion: input.promptVersion ?? null,
      })
      .returning({ id: messages.id });

    const messageId = inserted!.id;

    await tx.insert(messageMeta).values({
      messageId,
      model: input.model,
      provider: input.provider,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      costUsd: input.costUsd ?? null,
      latencyFirstTokenMs: input.firstTokenMs,
      latencyTotalMs: input.totalMs,
      retries: input.fallbackPath.length,
      fallbackPath: input.fallbackPath,
      idempotencyKey: input.idempotencyKey,
      requestId: input.requestId ?? null,
    } as never);

    // Touch conversation.updated_at (also done by the SQL trigger, but
    // explicit here so the change is visible in the same transaction).
    await tx
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, input.conversationId));

    return messageId;
  });
}
