import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@supa/db";
import { workspaces, workspaceMembers } from "@supa/db/schema";
import { eq } from "drizzle-orm";
import { supabaseServer } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/session";
import { guard } from "@/lib/ratelimit/guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { problem, ok } from "@/lib/api/problem";
import { ip } from "@/lib/utils/ip";

/**
 * GET /api/workspaces
 *
 * Returns all workspaces the caller is a member of, with their role.
 */
export async function GET(req: NextRequest) {
  const denied = await guard(req, "default");
  if (denied) return denied;

  const user = await requireUser();

  const rows = await db
    .select({
      id: workspaces.id,
      slug: workspaces.slug,
      name: workspaces.name,
      logoPath: workspaces.logoPath,
      isPersonal: workspaces.isPersonal,
      plan: workspaces.plan,
      seatLimit: workspaces.seatLimit,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, user.id))
    .orderBy(workspaces.isPersonal, workspaces.name);

  return ok({ workspaces: rows });
}

const Body = z.object({
  name: z.string().min(2).max(80),
  slug: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-]+[a-z0-9]$/, "slug must be lowercase letters, digits, hyphens"),
});

/**
 * POST /api/workspaces
 *
 * Creates a workspace + owner membership row in a single RPC call.
 * The RPC `create_workspace(name, slug, owner_id)` runs as SECURITY DEFINER
 * so it can write to both `workspaces` and `workspace_members` atomically.
 *
 * Rate-limited per IP at 3/hour (signup-style budget — creating workspaces
 * is a low-frequency action).
 */
export async function POST(req: NextRequest) {
  const user = await requireUser();

  const rl = await checkRateLimit("signup", ip(req));
  if (!rl.ok) {
    return problem(429, "rate_limited", undefined, { retryAfter: rl.retryAfter });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return problem(400, "invalid_json");
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return problem(400, "invalid_request", parsed.error.issues[0]?.message);
  }

  const supabase = await supabaseServer();
  const { data: wsId, error } = await supabase.rpc("create_workspace", {
    p_name: parsed.data.name,
    p_slug: parsed.data.slug,
    p_owner_id: user.id,
  });

  if (error) {
    if (error.code === "23505" || /already in use/i.test(error.message)) {
      return problem(409, "slug_taken");
    }
    return problem(500, "create_failed");
  }

  return ok({ id: wsId, slug: parsed.data.slug, name: parsed.data.name }, 201);
}
