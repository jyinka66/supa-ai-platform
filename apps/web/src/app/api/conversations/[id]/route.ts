import { NextRequest } from "next/server";
import { z } from "zod";
import { MODES } from "@/lib/prompts";
import { requireUser } from "@/lib/auth/session";
import { problem, ok } from "@/lib/api/problem";
import {
  getConversation,
  updateConversation,
  deleteConversation,
} from "@/lib/chat/queries";

const PatchBody = z.object({
  title: z.string().min(1).max(200).optional(),
  pinned: z.boolean().optional(),
  folderId: z.string().uuid().nullable().optional(),
  mode: z.enum(MODES).optional(),
});

/**
 * GET /api/conversations/:id
 *
 * Returns a single conversation. RLS enforces access; we re-check here
 * for a clean 403/404.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireUser();
  try {
    const conv = await getConversation(id, user.id);
    return ok(conv);
  } catch (err) {
    const code = (err as Error).message;
    if (code === "not_found") return problem(404, "conversation_not_found");
    if (code === "forbidden") return problem(403, "forbidden");
    return problem(500, "fetch_failed");
  }
}

/**
 * PATCH /api/conversations/:id
 *
 * Updates title, pinned, folderId, or AI mode. Only the owner can patch.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireUser();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return problem(400, "invalid_json");
  }
  const parsed = PatchBody.safeParse(body);
  if (!parsed.success) {
    return problem(400, "invalid_request", parsed.error.issues[0]?.message);
  }

  try {
    const conv = await updateConversation(id, user.id, parsed.data);
    return ok(conv);
  } catch (err) {
    const code = (err as Error).message;
    if (code === "not_found") return problem(404, "conversation_not_found");
    if (code === "forbidden") return problem(403, "forbidden");
    return problem(500, "update_failed");
  }
}

/**
 * DELETE /api/conversations/:id
 *
 * Deletes a conversation. Only the owner can delete.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireUser();
  try {
    await deleteConversation(id, user.id);
    return ok({ id, deleted: true });
  } catch (err) {
    const code = (err as Error).message;
    if (code === "not_found") return problem(404, "conversation_not_found");
    if (code === "forbidden") return problem(403, "forbidden");
    return problem(500, "delete_failed");
  }
}
