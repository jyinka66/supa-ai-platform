import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@supa/db";
import { workspaceMembers } from "@supa/db/schema";
import { eq, and } from "drizzle-orm";
import { requireUser, assertRole, rotateSessions } from "@/lib/auth/session";
import { guard } from "@/lib/ratelimit/guard";
import { problem, ok } from "@/lib/api/problem";
import { audit } from "@/lib/audit";
import { ip } from "@/lib/utils/ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PatchBody = z.object({
  role: z.enum(["admin", "member", "viewer"]),
}).strict();

/**
 * PATCH /api/workspaces/:id/members/:userId
 *
 * Changes a member's role. Only owner/admin can change roles.
 * Owners cannot be demoted by admins (only by other owners — future).
 * Changing a role rotates the affected user's sessions (security).
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; userId: string }> },
) {
  const denied = await guard(req, "default");
  if (denied) return denied;

  const user = await requireUser();
  const { id: wsId, userId: targetUserId } = await params;

  const allowed = await assertRole(user.id, wsId, ["owner", "admin"]);
  if (!allowed) return problem(403, "forbidden");

  let body: unknown;
  try { body = await req.json(); } catch { return problem(400, "invalid_json"); }
  const parsed = PatchBody.safeParse(body);
  if (!parsed.success) return problem(400, "invalid_request", parsed.error.issues[0]?.message);

  // Verify the target is a member.
  const existing = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, wsId), eq(workspaceMembers.userId, targetUserId)))
    .limit(1);

  if (!existing[0]) return problem(404, "member_not_found");

  // Prevent demoting owners via this route.
  if (existing[0].role === "owner") return problem(403, "cannot_change_owner_role");

  await db
    .update(workspaceMembers)
    .set({ role: parsed.data.role })
    .where(and(eq(workspaceMembers.workspaceId, wsId), eq(workspaceMembers.userId, targetUserId)));

  // Rotate the affected user's sessions (privilege change → force re-login).
  await rotateSessions(targetUserId).catch(() => {});

  await audit({
    actorId: user.id, actorKind: "user",
    action: "workspace_member.role_change",
    targetType: "workspace_member", targetId: targetUserId,
    metadata: { workspaceId: wsId, oldRole: existing[0].role, newRole: parsed.data.role },
    ip: ip(req),
  });

  return ok({ userId: targetUserId, role: parsed.data.role });
}

/**
 * DELETE /api/workspaces/:id/members/:userId
 *
 * Removes a member from the workspace. Only owner/admin can remove others.
 * Users can remove themselves (self-leave).
 * Owners cannot be removed via this route (must transfer ownership first — future).
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; userId: string }> },
) {
  const denied = await guard(req, "default");
  if (denied) return denied;

  const user = await requireUser();
  const { id: wsId, userId: targetUserId } = await params;

  // Self-leave is always allowed; removing others requires admin.
  const isSelf = user.id === targetUserId;
  if (!isSelf) {
    const allowed = await assertRole(user.id, wsId, ["owner", "admin"]);
    if (!allowed) return problem(403, "forbidden");
  }

  // Verify the target is a member.
  const existing = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, wsId), eq(workspaceMembers.userId, targetUserId)))
    .limit(1);

  if (!existing[0]) return problem(404, "member_not_found");

  // Prevent removing owners.
  if (existing[0].role === "owner") return problem(403, "cannot_remove_owner");

  await db
    .delete(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, wsId), eq(workspaceMembers.userId, targetUserId)));

  // Rotate the removed user's sessions.
  await rotateSessions(targetUserId).catch(() => {});

  await audit({
    actorId: user.id, actorKind: "user",
    action: "workspace_member.remove",
    targetType: "workspace_member", targetId: targetUserId,
    metadata: { workspaceId: wsId, wasRole: existing[0].role, selfRemoved: isSelf },
    ip: ip(req),
  });

  return ok({ userId: targetUserId, removed: true });
}
