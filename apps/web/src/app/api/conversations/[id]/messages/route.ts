import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth/session";
import { problem, ok } from "@/lib/api/problem";
import { getConversation, getMessages } from "@/lib/chat/queries";

/**
 * GET /api/conversations/:id/messages
 *
 * Returns the message list for a conversation, oldest-first.
 * Query params:
 *   ?limit=50  — max messages (default 50, max 200)
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: conversationId } = await params;
  const user = await requireUser();

  // Verify access first.
  try {
    await getConversation(conversationId, user.id);
  } catch (err) {
    const code = (err as Error).message;
    if (code === "not_found") return problem(404, "conversation_not_found");
    if (code === "forbidden") return problem(403, "forbidden");
    return problem(500, "fetch_failed");
  }

  const url = new URL(req.url);
  const limitRaw = url.searchParams.get("limit") ?? "50";
  const limit = Math.min(Math.max(parseInt(limitRaw, 10) || 50, 1), 200);

  const msgs = await getMessages(conversationId, limit);
  return ok(msgs);
}
