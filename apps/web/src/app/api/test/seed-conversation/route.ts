import { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { problem, ok } from "@/lib/api/problem";
import { testGate } from "@/lib/test/gate";
import { createConversation } from "@/lib/chat/queries";
import { db } from "@supa/db";
import { messages } from "@supa/db/schema";

const Body = z.object({
  workspaceId: z.string().uuid(),
  messageCount: z.number().int().min(1).max(5000).default(500),
  mode: z
    .enum(["chat", "write", "rewrite", "summarize", "translate", "code", "image", "document", "plan"])
    .default("chat"),
  title: z.string().max(200).optional(),
});

/**
 * POST /api/test/seed-conversation
 *
 * Creates a conversation with N synthetic messages for load testing.
 * Messages alternate user/assistant with predictable content:
 *   "User message #1", "Assistant response #1", "User message #2", ...
 *
 * Test-only — returns 404 in production.
 *
 * Auth: caller must be signed in (the conversation is owned by them).
 */
export async function POST(req: NextRequest) {
  const gate = testGate(req);
  if (gate) return gate;

  const user = await requireUser();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return problem(400, "invalid_json");
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return problem(400, "invalid_request", parsed.error.issues[0]?.message);
  }
  const { workspaceId, messageCount, mode, title } = parsed.data;

  // Create the conversation.
  const conversation = await createConversation({
    workspaceId,
    userId: user.id,
    mode,
    title: title ?? `Load test — ${messageCount} messages`,
  });

  // Bulk-insert messages in batches of 100 to avoid Postgres parameter limits
  // (65535 params / ~5 columns per row = ~13k rows per batch, but 100 is a
  // safe batch size that keeps memory bounded).
  const BATCH_SIZE = 100;
  const batches: Array<typeof messages.$inferInsert>[] = [];

  for (let i = 0; i < messageCount; i++) {
    const role = i % 2 === 0 ? "user" : "assistant";
    const content = `${role === "user" ? "User" : "Assistant"} message #${i + 1} — ${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(3)}`;
    batches.push({
      conversationId: conversation.id,
      role,
      content,
      status: "completed",
    } as never);

    if (batches.length >= BATCH_SIZE) {
      await db.insert(messages).values(batches as never);
      batches.length = 0;
    }
  }
  // Flush remaining.
  if (batches.length > 0) {
    await db.insert(messages).values(batches as never);
  }

  return ok({
    conversationId: conversation.id,
    messageCount,
  }, 201);
}
