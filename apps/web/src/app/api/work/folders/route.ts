import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@supa/db";
import { workFolders } from "@supa/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { requireUser } from "@/lib/auth/session";
import { guard } from "@/lib/ratelimit/guard";
import { problem, ok } from "@/lib/api/problem";
import { audit } from "@/lib/audit";
import { ip } from "@/lib/utils/ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateBody = z.object({
  name: z.string().min(1).max(100),
  parentId: z.string().uuid().nullable().optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  type: z.enum(["manual", "smart"]).default("manual"),
  smartParams: z.record(z.unknown()).optional(),
}).strict();

/**
 * POST /api/work/folders
 *
 * Creates a new folder (manual or smart).
 *
 * For smart folders, pass `type: "smart"` + `smartParams: { ...SearchParams }`.
 * The trigger prevents smart folders from having children.
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

  // Resolve workspace from cookie.
  const wsCookie = req.cookies.get("ws")?.value;
  if (!wsCookie) {
    return problem(400, "no_workspace_selected");
  }

  // If parentId is set, verify it exists + is in the same workspace + isn't a smart folder.
  if (parsed.data.parentId) {
    const parentRows = await db
      .select({ id: workFolders.id, type: workFolders.type, workspaceId: workFolders.workspaceId })
      .from(workFolders)
      .where(eq(workFolders.id, parsed.data.parentId))
      .limit(1);

    const parent = parentRows[0];
    if (!parent) {
      return problem(404, "parent_not_found");
    }
    if (parent.workspaceId !== wsCookie) {
      return problem(403, "cross_workspace");
    }
    if (parent.type === "smart") {
      return problem(400, "smart_folder_cannot_have_children");
    }
  }

  // Check for name conflict at the same level.
  const existing = await db
    .select({ id: workFolders.id })
    .from(workFolders)
    .where(
      and(
        eq(workFolders.workspaceId, wsCookie),
        parsed.data.parentId
          ? eq(workFolders.parentId, parsed.data.parentId)
          : isNull(workFolders.parentId),
        eq(workFolders.name, parsed.data.name),
      ),
    )
    .limit(1);
  if (existing[0]) {
    return problem(409, "name_conflict");
  }

  const [created] = await db
    .insert(workFolders)
    .values({
      workspaceId: wsCookie,
      parentId: parsed.data.parentId ?? null,
      name: parsed.data.name,
      color: parsed.data.color ?? null,
      type: parsed.data.type,
      smartParams: parsed.data.type === "smart" ? (parsed.data.smartParams ?? {}) : null,
      createdBy: user.id,
      path: "", // populated by trigger
    })
    .returning();

  if (!created) {
    return problem(500, "create_failed");
  }

  return ok(created, 201);
}

/**
 * GET /api/work/folders
 *
 * Returns all folders for the current workspace (flat list).
 * Use /api/work/folders/tree for the hierarchical tree.
 */
export async function GET(req: NextRequest) {
  const denied = await guard(req, "default");
  if (denied) return denied;

  await requireUser();

  const wsCookie = req.cookies.get("ws")?.value;
  if (!wsCookie) {
    return problem(400, "no_workspace_selected");
  }

  const folders = await db
    .select()
    .from(workFolders)
    .where(eq(workFolders.workspaceId, wsCookie))
    .orderBy(workFolders.name);

  return ok({ folders });
}
