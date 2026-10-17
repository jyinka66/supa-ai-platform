import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const ADMIN = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

type Role = "owner" | "admin" | "member" | "viewer";

export type Actor = { id: string; client: SupabaseClient };

export type WorkspaceRow = { id: string; slug: string; name: string; is_personal: boolean };

/**
 * Minimal valid column set per table — used by parameterised RLS write tests.
 * Returns snake_case keys to match PostgREST column names.
 */
export function minValidRow(table: string): Record<string, unknown> {
  switch (table) {
    case "invites":
      return { email: "x@y.z", token_hash: "h" };
    case "workspace_members":
      return { role: "member" };
    case "profiles":
      return { timezone: "UTC", language: "en" };
    case "workspaces":
      return { slug: "test-ws", name: "Test" };
    case "user_sessions":
      return { user_id: crypto.randomUUID() };
    default:
      return {};
  }
}

export async function createTestUsers() {
  // Creates: owner+admin+member+viewer in workspace A, admin+member in workspace B.
  // Returns typed actors bound to per-user anon keys so RLS actually evaluates.
  const mk = async (email: string, role?: Role, wsId?: string): Promise<Actor> => {
    // Capture password once — reuse for both createUser and signInWithPassword.
    const password = crypto.randomUUID() + "!Aa1";
    const { data, error } = await ADMIN.auth.admin.createUser({ email, password });
    if (error) throw error;

    if (wsId && role) {
      await ADMIN.from("workspace_members").insert({
        workspace_id: wsId,
        user_id: data.user.id,
        role,
      });
    }

    const userClient = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
    const { error: signInError } = await userClient.auth.signInWithPassword({ email, password });
    if (signInError) throw signInError;
    return { id: data.user.id, client: userClient };
  };

  // --- Workspace A: owner + admin + member + viewer ---
  const ownerA = await mk("owner-a@test.local");

  // Try to reuse an existing non-personal workspace, otherwise create one.
  const existingWsA = await ADMIN.from("workspaces")
    .select()
    .eq("is_personal", false)
    .limit(1)
    .maybeSingle();

  let wsA: WorkspaceRow;
  if (existingWsA.data) {
    wsA = existingWsA.data as WorkspaceRow;
  } else {
    const created = await ADMIN.from("workspaces")
      .insert({ slug: "ws-a", name: "A", is_personal: false, billing_owner_id: ownerA.id })
      .select()
      .single();
    if (!created.data) throw new Error("Failed to create wsA");
    wsA = created.data as WorkspaceRow;
  }

  const [adminA, memberA, viewerA] = await Promise.all([
    mk("admin-a@test.local", "admin", wsA.id),
    mk("member-a@test.local", "member", wsA.id),
    mk("viewer-a@test.local", "viewer", wsA.id),
  ]);

  // --- Workspace B: admin + member ---
  const adminB = await mk("admin-b@test.local");
  const wsBResult = await ADMIN.from("workspaces")
    .insert({ slug: "ws-b", name: "B", is_personal: false, billing_owner_id: adminB.id })
    .select()
    .single();
  if (!wsBResult.data) throw new Error("Failed to create wsB");
  const wsB = wsBResult.data as WorkspaceRow;
  const memberB = await mk("member-b@test.local", "member", wsB.id);

  // --- Owner A's personal workspace (created by the handle_new_user trigger) ---
  const personalWsAResult = await ADMIN.from("workspaces")
    .select()
    .eq("is_personal", true)
    .eq("billing_owner_id", ownerA.id)
    .maybeSingle();
  if (!personalWsAResult.data) throw new Error("Personal workspace not found for ownerA");
  const personalWsA = personalWsAResult.data as WorkspaceRow;

  return {
    ownerA,
    adminA,
    memberA,
    viewerA,
    wsA,
    adminB,
    memberB,
    wsB,
    personalWsA,
    userA: memberA,
    userB: memberB,
  };
}

export function setRlsActor(actor: Actor): SupabaseClient {
  return actor.client;
}

export async function purgeTenant(wsId: string) {
  await ADMIN.from("workspaces").delete().eq("id", wsId); // cascades members, invites
}

/**
 * Log an RLS violation attempt. Called by tests after catching a PostgrestError
 * with code 42501 / message matching /row-level security|violates/i.
 * The database itself doesn't auto-log RLS rejections — the app layer must
 * call this when it catches the error.
 */
export async function logRlsViolation(
  workspaceId: string,
  userId: string,
  tableName: string,
): Promise<void> {
  await ADMIN.rpc("log_audit_event", {
    p_type: "rls_violation",
    p_user_id: userId,
    p_workspace_id: workspaceId,
    p_metadata: { table: tableName },
  });
}

export async function readAuditLog() {
  const { data, error } = await ADMIN.from("audit_log")
    .select()
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as Array<{ type: string; workspace_id: string | null }>;
}
