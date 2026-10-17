import { NextRequest } from "next/server";
import { db } from "@supa/db";
import { workspaceMembers, profiles } from "@supa/db/schema";
import { eq, and } from "drizzle-orm";
import { requireUser, assertRole } from "@/lib/auth/session";
import { guard } from "@/lib/ratelimit/guard";
import { problem, ok } from "@/lib/api/problem";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/workspaces/:id/members
 *
 * Returns all members of a workspace with their profiles + roles.
 * Any workspace member can read the member list.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await guard(req, "default");
  if (denied) return denied;

  const user = await requireUser();
  const { id: wsId } = await params;

  // Verify caller is a member.
  const isMember = await assertRole(user.id, wsId, ["owner", "admin", "member", "viewer"]);
  if (!isMember) return problem(403, "forbidden");

  const members = await db
    .select({
      userId: workspaceMembers.userId,
      role: workspaceMembers.role,
      invitedBy: workspaceMembers.invitedBy,
      createdAt: workspaceMembers.createdAt,
      fullName: profiles.fullName,
      avatarPath: profiles.avatarPath,
      isVerified: profiles.isVerified,
    })
    .from(workspaceMembers)
    .leftJoin(profiles, eq(profiles.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, wsId))
    .orderBy(workspaceMembers.createdAt);

  return ok({ members });
}
