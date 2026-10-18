import { cookies } from "next/headers";
import type { WorkspaceWithMembership } from "@/lib/workspaces/queries";

/** Return the saved workspace only when it belongs to the caller's RLS-filtered list. */
export async function getActiveWorkspaceId(workspaces: WorkspaceWithMembership[]): Promise<string> {
  const cookieStore = await cookies();
  const saved = cookieStore.get("ws")?.value;
  if (saved && workspaces.some((workspace) => workspace.id === saved)) return saved;
  return workspaces[0]?.id ?? "";
}
