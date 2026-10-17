import { NextRequest } from "next/server";
import { z } from "zod";
import { createHash } from "node:crypto";
import { db } from "@supa/db";
import { workShareLinks } from "@supa/db/schema";
import { eq, and } from "drizzle-orm";
import { requireUser } from "@/lib/auth/session";
import { guard } from "@/lib/ratelimit/guard";
import { problem, ok } from "@/lib/api/problem";
import { audit } from "@/lib/audit";
import { ip } from "@/lib/utils/ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PatchBody = z.object({
  role: z.enum(["view", "comment", "edit"]).optional(),
  password: z.string().min(1).max(1000).nullable().optional(), // null = remove password
  expiresInDays: z.number().int().min(1).max(365).nullable().optional(),
  revoked: z.boolean().optional(), // true = revoke
}).strict();

/**
 * PATCH /api/work/share/:id
 *
 * Updates a share link. Can change role, password, expiry, or revoke.
 *
 * Setting `revoked: true` is equivalent to DELETE (but doesn't remove the row —
 * the row remains for analytics).
 *
 * Setting `password: null` removes the password protection.
 * Setting `expiresInDays: null` removes the expiry (link never expires).
 *
 * Auth: only the creator can modify.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await guard(req, "default");
  if (denied) return denied;

  const user = await requireUser();
  const { id } = await params;

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

  // Fetch the link + verify ownership.
  const existing = await db
    .select()
    .from(workShareLinks)
    .where(eq(workShareLinks.id, id))
    .limit(1);

  const link = existing[0];
  if (!link) return problem(404, "not_found");
  if (link.createdBy !== user.id) return problem(403, "forbidden");

  // Build update set.
  const updateSet: Record<string, unknown> = {};

  if (parsed.data.role !== undefined) {
    updateSet.role = parsed.data.role;
  }

  if (parsed.data.password !== undefined) {
    updateSet.passwordHash = parsed.data.password === null
      ? null
      : createHash("sha256").update(parsed.data.password).digest("hex");
  }

  if (parsed.data.expiresInDays !== undefined) {
    updateSet.expiresAt = parsed.data.expiresInDays === null
      ? null
      : new Date(Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000);
  }

  if (parsed.data.revoked === true) {
    updateSet.revokedAt = new Date();
  }

  if (Object.keys(updateSet).length === 0) {
    return problem(400, "empty_patch");
  }

  const [updated] = await db
    .update(workShareLinks)
    .set(updateSet)
    .where(eq(workShareLinks.id, id))
    .returning();

  if (!updated) return problem(500, "update_failed");

  // Audit.
  await audit({
    actorId: user.id,
    actorKind: "user",
    action: parsed.data.revoked === true ? "share_link.revoke" : "share_link.create",
    targetType: "share_link",
    targetId: id,
    metadata: {
      changedFields: Object.keys(parsed.data),
      revoked: parsed.data.revoked === true,
    },
    ip: ip(req),
  });

  return ok({
    id: updated.id,
    role: updated.role,
    hasPassword: !!updated.passwordHash,
    expiresAt: updated.expiresAt,
    maxViews: updated.maxViews,
    viewCount: updated.viewCount,
    revokedAt: updated.revokedAt,
    isRevoked: !!updated.revokedAt,
  });
}

/**
 * DELETE /api/work/share/:id
 *
 * Revokes a share link (sets revoked_at = now()).
 * The row is NOT deleted — it remains for analytics.
 *
 * Auth: only the creator can revoke.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await guard(req, "default");
  if (denied) return denied;

  const user = await requireUser();
  const { id } = await params;

  const existing = await db
    .select({ createdBy: workShareLinks.createdBy, revokedAt: workShareLinks.revokedAt })
    .from(workShareLinks)
    .where(eq(workShareLinks.id, id))
    .limit(1);

  const link = existing[0];
  if (!link) return problem(404, "not_found");
  if (link.createdBy !== user.id) return problem(403, "forbidden");

  // Don't re-revoke.
  if (link.revokedAt) {
    return ok({ id, revoked: true, alreadyRevoked: true });
  }

  await db
    .update(workShareLinks)
    .set({ revokedAt: new Date() })
    .where(eq(workShareLinks.id, id));

  await audit({
    actorId: user.id,
    actorKind: "user",
    action: "share_link.revoke",
    targetType: "share_link",
    targetId: id,
    ip: ip(req),
  });

  return ok({ id, revoked: true });
}
