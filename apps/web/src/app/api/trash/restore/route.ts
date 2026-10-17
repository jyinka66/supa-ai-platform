import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@supa/db";
import { workItems } from "@supa/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { requireUser } from "@/lib/auth/session";
import { guard } from "@/lib/ratelimit/guard";
import { problem, ok } from "@/lib/api/problem";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
}).strict();

/**
 * POST /api/trash/restore
 *
 * Restores trashed items (status='trash' → 'active').
 * Only works on items that are currently trashed.
 * Returns a per-item result array.
 */
export async function POST(req: NextRequest) {
  const denied = await guard(req, "default");
  if (denied) return denied;

  const user = await requireUser();

  let body: unknown;
  try { body = await req.json(); } catch { return problem(400, "invalid_json"); }
  const parsed = Body.safeParse(body);
  if (!parsed.success) return problem(400, "invalid_request", parsed.error.issues[0]?.message);

  const wsCookie = req.cookies.get("ws")?.value;
  if (!wsCookie) return problem(400, "no_workspace_selected");

  // Restore only items owned by the caller that are currently trashed.
  const restored = await db
    .update(workItems)
    .set({ status: "active", trashedAt: null, trashedBy: null, updatedAt: new Date() })
    .where(
      and(
        inArray(workItems.id, parsed.data.ids),
        eq(workItems.ownerId, user.id),
        eq(workItems.status, "trash"),
      ),
    )
    .returning({ id: workItems.id });

  const restoredIds = new Set(restored.map((r) => r.id));
  const results = parsed.data.ids.map((id) => ({
    id,
    ok: restoredIds.has(id),
    reason: restoredIds.has(id) ? undefined : "not_trashed_or_not_owned",
  }));

  return ok({ results, restored: restored.length, failed: results.filter((r) => !r.ok).length });
}
