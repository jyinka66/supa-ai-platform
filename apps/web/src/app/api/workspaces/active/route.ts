import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { supabaseServer } from "@/lib/supabase/server";
import { problem } from "@/lib/api/problem";

const Body = z.object({ workspaceId: z.string().uuid() });

/**
 * Persist the active workspace for user-facing work APIs. Membership is
 * checked with the caller's Supabase session; the cookie is never trusted
 * as proof of access by itself.
 */
export async function POST(req: NextRequest) {
  const user = await requireUser();

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return problem(400, "invalid_json");
  }

  const parsed = Body.safeParse(raw);
  if (!parsed.success) return problem(400, "invalid_workspace", "Choose a valid workspace.");

  const supabase = await supabaseServer();
  const { data: membership, error } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("workspace_id", parsed.data.workspaceId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    console.error("[api/workspaces/active] membership_check_failed", { userId: user.id, error });
    return problem(503, "workspace_check_failed", "Could not verify workspace access. Please retry.");
  }
  if (!membership) return problem(403, "forbidden", "You are not a member of this workspace.");

  const response = NextResponse.json({ data: { workspaceId: parsed.data.workspaceId } });
  response.cookies.set("ws", parsed.data.workspaceId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 180,
  });
  return response;
}
