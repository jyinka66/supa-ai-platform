import { supabaseBrowser } from "@/lib/supabase/client";
import { supabaseServer, supabaseService } from "@/lib/supabase/server";

export type WorkspaceRole = "owner" | "admin" | "member" | "viewer";

export interface WorkspaceWithMembership {
  id: string;
  slug: string;
  name: string;
  logo_path: string | null;
  is_personal: boolean;
  plan: string;
  seat_limit: number;
  workspace_members: { role: WorkspaceRole }[];
}

/**
 * Lists workspaces the current user is a member of.
 * This helper is used by the server-rendered dashboard, so it must use the
 * cookie-aware server client rather than the browser client. RLS still scopes
 * the result to the authenticated user.
 */
export async function listWorkspaces(): Promise<WorkspaceWithMembership[]> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("workspaces")
    .select(
      "id, slug, name, logo_path, is_personal, plan, seat_limit, workspace_members!inner(role)",
    )
    .order("created_at", { ascending: false });

  if (error) throw error;
  return (data ?? []) as WorkspaceWithMembership[];
}

/**
 * Returns the caller's role in the given workspace.
 * The database function `workspace_role(ws_id)` reads `auth.uid()` server-side,
 * so the caller cannot query another user's role.
 */
export async function currentRole(wsId: string): Promise<WorkspaceRole> {
  const { data, error } = await supabaseBrowser.rpc("workspace_role", {
    ws_id: wsId,
  });

  if (error) throw error;
  const role = data as WorkspaceRole | null;
  return role ?? "viewer";
}

// ---------- Server-side helpers (called from route handlers) ----------

/**
 * Returns the current member count for a workspace.
 * Uses service-role because the caller may not yet be a member.
 */
export async function currentMemberCount(wsId: string): Promise<number> {
  const admin = supabaseService();
  const { count, error } = await admin
    .from("workspace_members")
    .select("*", { count: "exact", head: true })
    .eq("workspace_id", wsId);
  if (error) throw error;
  return count ?? 0;
}

/**
 * Returns true if the workspace is at or above its seat_limit.
 * Called before sending invites to prevent over-allocation.
 */
export async function seatsFull(wsId: string): Promise<boolean> {
  const admin = supabaseService();
  const { data: ws, error } = await admin
    .from("workspaces")
    .select("seat_limit")
    .eq("id", wsId)
    .maybeSingle();
  if (error) throw error;
  if (!ws) throw new Error("workspace_not_found");
  const count = await currentMemberCount(wsId);
  return count >= ws.seat_limit;
}

/**
 * Returns the workspace name for use in invite emails.
 * Uses service-role — invite senders may not yet be members of the target workspace
 * (though RLS would normally allow it, we want determinism).
 */
export async function getWorkspaceName(wsId: string): Promise<string> {
  const admin = supabaseService();
  const { data, error } = await admin
    .from("workspaces")
    .select("name")
    .eq("id", wsId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("workspace_not_found");
  return data.name;
}
