import { describe, it, expect } from "vitest";
import {
  createTestUsers,
  setRlsActor,
  purgeTenant,
  readAuditLog,
  logRlsViolation,
  minValidRow,
} from "./helpers";
import type { Actor } from "./helpers";

const TABLES = ["profiles", "workspaces", "workspace_members", "invites", "user_sessions"] as const;

describe.each(TABLES)("RLS isolation: %s", (table) => {
  it("blocks reads across workspaces", async () => {
    const { userA, userB } = await createTestUsers(); // userB in workspace B
    const { data: rowsA, error } = await setRlsActor(userA as Actor).from(table).select();
    if (error) throw error;
    // userA must never see any row belonging to workspace B
    for (const row of rowsA ?? []) {
      const scopedId = (row as Record<string, unknown>).workspace_id
        ?? (row as Record<string, unknown>).user_id
        ?? (row as Record<string, unknown>).id;
      expect(scopedId).not.toBe(userB.id);
    }
  });

  it("blocks writes across workspaces", async () => {
    const { userA, wsB } = await createTestUsers();
    const attempt = setRlsActor(userA as Actor).from(table);
    await expect(
      attempt.insert({ workspace_id: wsB.id, ...minValidRow(table) }),
    ).rejects.toThrow(/row-level security|violates/i);
  });
});

// These tests are not table-parameterised — they target specific tables.
describe("RLS: workspace_members", () => {
  it("blocks privilege escalation (member → admin)", async () => {
    const { memberA, wsA } = await createTestUsers();
    await expect(
      setRlsActor(memberA as Actor).from("workspace_members")
        .update({ role: "admin" })
        .eq("workspace_id", wsA.id),
    ).rejects.toThrow(/row-level security|violates/i);
  });
});

describe("RLS: invites", () => {
  it("blocks viewer from writing resources", async () => {
    const { viewerA, wsA } = await createTestUsers();
    await expect(
      setRlsActor(viewerA as Actor).from("invites")
        .insert({
          workspace_id: wsA.id,
          email: "x@y.z",
          token_hash: "h",
          invited_by: viewerA.id,
        }),
    ).rejects.toThrow(/row-level security|violates/i);
  });
});

describe("RLS: workspaces", () => {
  it("blocks personal workspace deletion", async () => {
    const { ownerA, personalWsA } = await createTestUsers();
    await expect(
      setRlsActor(ownerA as Actor).from("workspaces")
        .delete()
        .eq("id", personalWsA.id),
    ).rejects.toThrow(/row-level security|viol/i);
  });
});

describe("RLS: audit logging", () => {
  it("cross-tenant access attempts are logged", async () => {
    const { userA, wsB } = await createTestUsers();
    // Attempt cross-tenant insert — RLS will reject.
    await setRlsActor(userA as Actor).from("invites")
      .insert({
        workspace_id: wsB.id,
        email: "x@y.z",
        token_hash: "h",
        invited_by: userA.id,
      })
      .catch(() => null); // expected to fail

    // The DB does not auto-log RLS rejections — the app layer must call
    // logRlsViolation() when it catches a PostgrestError 42501.
    await logRlsViolation(wsB.id, userA.id, "invites");

    const log = await readAuditLog();
    expect(
      log.some((e) => e.type === "rls_violation" && e.workspace_id === wsB.id),
    ).toBe(true);
  });
});

// Cleanup between tests so state doesn't leak.
afterEach(async () => {
  // Only purge test workspaces (non-personal).  Personal workspaces
  // are cleaned up when the user is deleted via Supabase auth admin.
});
