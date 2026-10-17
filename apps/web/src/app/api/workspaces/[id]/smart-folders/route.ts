import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@supa/db";
import { workFolders } from "@supa/db/schema";
import { eq, and } from "drizzle-orm";
import { requireUser, assertRole } from "@/lib/auth/session";
import { guard } from "@/lib/ratelimit/guard";
import { problem, ok } from "@/lib/api/problem";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateBody = z.object({
  name: z.string().min(1).max(100),
  parentId: z.string().uuid().nullable().optional(),
  smartParams: z.record(z.unknown()),
}).strict();

/**
 * POST /api/workspaces/:id/smart-folders
 *
 * Creates a smart folder (saved search rendered as a folder).
 * `smartParams` is the full SearchParams object that defines the folder contents.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await guard(req, "default");
  if (denied) return denied;

  const user = await requireUser();
  const { id: wsId } = await params;

  const allowed = await assertRole(user.id, wsId, ["owner", "admin", "member"]);
  if (!allowed) return problem(403, "forbidden");

  let body: unknown;
  try { body = await req.json(); } catch { return problem(400, "invalid_json"); }
  const parsed = CreateBody.safeParse(body);
  if (!parsed.success) return problem(400, "invalid_request", parsed.error.issues[0]?.message);

  const [created] = await db
    .insert(workFolders)
    .values({
      workspaceId: wsId,
      parentId: parsed.data.parentId ?? null,
      name: parsed.data.name,
      type: "smart",
      smartParams: parsed.data.smartParams,
      createdBy: user.id,
      path: "",
    })
    .returning();

  if (!created) return problem(500, "create_failed");
  return ok(created, 201);
}

/**
 * GET /api/workspaces/:id/smart-folders
 *
 * Returns all smart folders for the workspace.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await guard(req, "default");
  if (denied) return denied;

  const user = await requireUser();
  const { id: wsId } = await params;

  const allowed = await assertRole(user.id, wsId, ["owner", "admin", "member", "viewer"]);
  if (!allowed) return problem(403, "forbidden");

  const folders = await db
    .select()
    .from(workFolders)
    .where(and(eq(workFolders.workspaceId, wsId), eq(workFolders.type, "smart")))
    .orderBy(workFolders.name);

  return ok({ smartFolders: folders });
}
