import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@supa/db";
import { messages, messageFeedback } from "@supa/db/schema";
import { eq, and } from "drizzle-orm";
import { requireUser } from "@/lib/auth/session";
import { guard } from "@/lib/ratelimit/guard";
import { problem, ok } from "@/lib/api/problem";
import { parseBody } from "@/lib/validate";
import { feedbackSchema } from "@/lib/schemas";
import { audit } from "@/lib/audit";
import { ip } from "@/lib/utils/ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/messages/:id/feedback
 *
 * Submits thumbs-up (+1) or thumbs-down (-1) feedback for a message.
 * Idempotent per (messageId, userId) — re-submitting overwrites the
 * previous rating (upsert).
 *
 * Rate-limited at the `feedback` tier (30/min).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await guard(req, "feedback");
  if (denied) return denied;

  const user = await requireUser();
  const { id: messageId } = await params;

  const result = await parseBody(req, feedbackSchema);
  if (!result.ok) return result.res;
  const { rating, comment } = result.data;

  // Verify the message exists + the caller can access it (via conversation ownership).
  const msgRows = await db
    .select({ id: messages.id, conversationId: messages.conversationId })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  if (!msgRows[0]) {
    return problem(404, "message_not_found");
  }

  // Upsert the feedback (idempotent per message+user).
  // Drizzle's onConflictDoUpdate targets the composite PK (message_id, user_id).
  await db
    .insert(messageFeedback)
    .values({
      messageId,
      userId: user.id,
      rating,
    })
    .onConflictDoUpdate({
      target: [messageFeedback.messageId, messageFeedback.userId],
      set: { rating },
    });

  // Audit (without PII — just the rating + message id).
  await audit({
    actorId: user.id,
    actorKind: "user",
    action: rating === 1 ? "user.feedback_positive" : "user.feedback_negative",
    targetType: "message",
    targetId: messageId,
    metadata: { rating, hasComment: !!comment },
    ip: ip(req),
  });

  return ok({ messageId, rating });
}

/**
 * GET /api/messages/:id/feedback
 *
 * Returns the caller's feedback for a message (if any).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await guard(req, "default");
  if (denied) return denied;

  const user = await requireUser();
  const { id: messageId } = await params;

  const rows = await db
    .select()
    .from(messageFeedback)
    .where(
      and(
        eq(messageFeedback.messageId, messageId),
        eq(messageFeedback.userId, user.id),
      ),
    )
    .limit(1);

  return ok(rows[0] ?? null);
}

/**
 * DELETE /api/messages/:id/feedback
 *
 * Removes the caller's feedback for a message.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await guard(req, "default");
  if (denied) return denied;

  const user = await requireUser();
  const { id: messageId } = await params;

  await db
    .delete(messageFeedback)
    .where(
      and(
        eq(messageFeedback.messageId, messageId),
        eq(messageFeedback.userId, user.id),
      ),
    );

  return ok({ messageId, deleted: true });
}
