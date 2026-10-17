import { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { guard } from "@/lib/ratelimit/guard";
import { problem, ok } from "@/lib/api/problem";
import { createConversation, listConversations } from "@/lib/chat/queries";
import { MODES, type Mode } from "@/lib/prompts";

const CreateBody = z.object({
  workspaceId: z.string().uuid(),
  mode: z.enum(MODES).default("chat"),
  title: z.string().max(200).optional(),
  languagePref: z
    .string()
    .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
    .optional(),
  folderId: z.string().uuid().nullable().optional(),
});

/**
 * POST /api/conversations
 *
 * Creates a new conversation. The caller must be a member of the workspace
 * (RLS enforces this on the INSERT, but we also assert via assertRole for
 * a clean 403).
 */
export async function POST(req: NextRequest) {
  const denied = await guard(req, "default");
  if (denied) return denied;

  const user = await requireUser();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return problem(400, "invalid_json");
  }
  const parsed = CreateBody.safeParse(body);
  if (!parsed.success) {
    return problem(400, "invalid_request", parsed.error.issues[0]?.message);
  }

  try {
    const conv = await createConversation({
      workspaceId: parsed.data.workspaceId,
      userId: user.id,
      mode: parsed.data.mode as Mode,
      title: parsed.data.title ?? null,
      languagePref: parsed.data.languagePref ?? null,
      folderId: parsed.data.folderId ?? null,
    });
    return ok(conv, 201);
  } catch (err) {
    return problem(500, "create_failed", String(err));
  }
}

/**
 * GET /api/conversations
 *
 * Lists the caller's conversations, newest-first.
 * Query params:
 *   ?pinned=true  — only pinned conversations
 *   ?folderId=... — only conversations in that folder (use "null" for no folder)
 */
export async function GET(req: NextRequest) {
  const user = await requireUser();
  const url = new URL(req.url);
  const pinnedOnly = url.searchParams.get("pinned") === "true";
  const folderIdRaw = url.searchParams.get("folderId");
  const folderId =
    folderIdRaw === "null" ? null : folderIdRaw === null ? undefined : folderIdRaw;

  const convs = await listConversations(user.id, {
    pinnedOnly,
    folderId,
  });
  return ok(convs);
}
