import { NextRequest } from "next/server";
import { db } from "@supa/db";
import { workFolders, workItems } from "@supa/db/schema";
import { eq, and, sql, isNull } from "drizzle-orm";
import { Redis } from "@upstash/redis";
import { requireUser } from "@/lib/auth/session";
import { guard } from "@/lib/ratelimit/guard";
import { problem, ok } from "@/lib/api/problem";

const redis = Redis.fromEnv();
const CACHE_TTL_SECONDS = 30;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface FolderNode {
  id: string;
  name: string;
  color: string | null;
  type: string;
  smartParams: Record<string, unknown> | null;
  parentId: string | null;
  path: string;
  itemcount: number;
  childCount: number;
  children: FolderNode[];
}

/**
 * GET /api/work/folders/tree
 *
 * Returns the full folder tree for the current workspace, with item counts.
 * Cached in Redis for 30s to avoid re-computing on every sidebar render.
 *
 * The tree is built in memory (not via recursive CTE) because the number
 * of folders per workspace is typically small (<100).
 *
 * Smart folders are included with their `smartParams` — the client uses
 * these to compute contents via searchWorkItems().
 */
export async function GET(req: NextRequest) {
  const denied = await guard(req, "default");
  if (denied) return denied;

  await requireUser();

  const wsCookie = req.cookies.get("ws")?.value;
  if (!wsCookie) {
    return problem(400, "no_workspace_selected");
  }

  // Check cache.
  const cacheKey = `folder_tree:${wsCookie}`;
  const cached = await redis.get<FolderNode[]>(cacheKey);
  if (cached) {
    return ok({ tree: cached, cached: true });
  }

  // Fetch all folders for the workspace.
  const folders = await db
    .select({
      id: workFolders.id,
      name: workFolders.name,
      color: workFolders.color,
      type: workFolders.type,
      smartParams: workFolders.smartParams,
      parentId: workFolders.parentId,
      path: workFolders.path,
    })
    .from(workFolders)
    .where(eq(workFolders.workspaceId, wsCookie));

  // Fetch item counts per folder.
  const counts = await db
    .select({
      folderId: workItems.folderId,
      count: sql<number>`count(*)::int`,
    })
    .from(workItems)
    .where(
      and(
        eq(workItems.workspaceId, wsCookie),
        eq(workItems.status, "active"),
        sql`${workItems.folderId} IS NOT NULL`,
      ),
    )
    .groupBy(workItems.folderId);

  const countMap = new Map<string, number>();
  for (const c of counts) {
    if (c.folderId) {
      countMap.set(c.folderId, c.count);
    }
  }

  // Build the tree.
  const nodeMap = new Map<string, FolderNode>();
  const roots: FolderNode[] = [];

  // Create nodes.
  for (const f of folders) {
    nodeMap.set(f.id, {
      id: f.id,
      name: f.name,
      color: f.color,
      type: f.type,
      smartParams: f.smartParams as Record<string, unknown> | null,
      parentId: f.parentId,
      path: f.path,
      itemcount: countMap.get(f.id) ?? 0,
      childCount: 0,
      children: [],
    });
  }

  // Link children to parents.
  for (const f of folders) {
    const node = nodeMap.get(f.id)!;
    if (f.parentId && nodeMap.has(f.parentId)) {
      const parent = nodeMap.get(f.parentId)!;
      parent.children.push(node);
      parent.childCount++;
    } else {
      roots.push(node);
    }
  }

  // Cache the tree.
  await redis.set(cacheKey, roots, { ex: CACHE_TTL_SECONDS });

  return ok({ tree: roots, cached: false });
}
