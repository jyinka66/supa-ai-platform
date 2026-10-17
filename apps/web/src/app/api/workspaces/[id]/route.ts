import { NextRequest } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { requireUser, assertRole } from "@/lib/auth/session";
import { problem, ok } from "@/lib/api/problem";

const Patch = z.object({
  name: z.string().min(2).max(80).optional(),
  slug: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-]+[a-z0-9]$/)
    .optional(),
  logo_path: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  timezone: z.string().optional(),
  default_language: z.string().optional(),
  plan: z.string().optional(),
  seat_limit: z.number().int().min(1).max(1000).optional(),
});

/**
 * PATCH /api/workspaces/:id
 *
 * Updates workspace settings. Defense in depth: even though RLS already
 * restricts UPDATE to {owner, admin}, we re-check explicitly here so the
 * route returns a clean 403 (RLS would 404 the row instead, leaking info).
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: wsId } = await params;
  const user = await requireUser();

  // Explicit role check — defense in depth.
  const allowed = await assertRole(user.id, wsId, ["owner", "admin"]);
  if (!allowed) {
    return problem(403, "forbidden");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return problem(400, "invalid_json");
  }
  const parsed = Patch.safeParse(body);
  if (!parsed.success) {
    return problem(400, "invalid_request", parsed.error.issues[0]?.message);
  }
  if (Object.keys(parsed.data).length === 0) {
    return problem(400, "empty_patch");
  }

  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("workspaces")
    .update(parsed.data)
    .eq("id", wsId)
    .select("id, slug, name, logo_path, country, timezone, default_language, plan, seat_limit")
    .maybeSingle();

  if (error) {
    if (error.code === "23505") return problem(409, "slug_taken");
    return problem(500, "update_failed");
  }
  if (!data) return problem(404, "workspace_not_found");

  return ok(data);
}

/**
 * DELETE /api/workspaces/:id
 *
 * Soft-deletes (hard delete via RLS) a non-personal workspace.
 * Personal workspaces cannot be deleted here — they're torn down via
 * account deletion flow.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: wsId } = await params;
  const user = await requireUser();

  const isOwner = await assertRole(user.id, wsId, ["owner"]);
  if (!isOwner) {
    return problem(403, "forbidden");
  }

  const supabase = await supabaseServer();
  // ws_delete policy already prevents deleting personal workspaces — this
  // is the last line of defense; the UI hides the button for personal ws.
  const { error } = await supabase.from("workspaces").delete().eq("id", wsId);
  if (error) return problem(500, "delete_failed");

  return ok({ id: wsId });
}
