import { NextRequest } from "next/server";
import { db } from "@supa/db";
import { workItems } from "@supa/db/schema";
import { eq, and } from "drizzle-orm";
import { requireUser } from "@/lib/auth/session";
import { guard } from "@/lib/ratelimit/guard";
import { problem, ok } from "@/lib/api/problem";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/work/items/:id/restore
 *
 * Restores a single trashed item (status='trash' → 'active').
 * Only the owner can restore.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await guard(req, "default");
  if (denied) return denied;

  const user = await requireUser();
  const { id } = await params;

  // Verify the item exists + is owned by the caller + is trashed.
  const existing = await db
    .select({ id: workItems.id, ownerId: workItems.ownerId, status: workItems.status })
    .from(workItems)
    .where(eq(workItems.id, id))
    .limit(1);

  if (!existing[0]) return problem(404, "not_found");
  if (existing[0].ownerId !== user.id) return problem(403, "forbidden");
  if (existing[0].status !== "trash") return problem(400, "not_trashed");

  await db
    .update(workItems)
    .set({ status: "active", trashedAt: null, trashedBy: null, updatedAt: new Date() })
    .where(eq(workItems.id, id));

  return ok({ id, restored: true });
}
