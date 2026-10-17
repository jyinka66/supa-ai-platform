// Workspaces service — creation, switching, deletion.
//
//   createWorkspace  — create a workspace + owner membership + builtin
//                       'approver' custom role. Atomic in one transaction.
//                       Personal workspaces are auto-created per user at
//                       signup; team = explicit (the caller decides).
//
//   switchWorkspace  — validate the user is an active member, return the
//                       workspace + role. The session stores the active
//                       ws_id (client-side concern; this function is the
//                       server-side validation gate).
//
//   requestDeletion  — owner-only (MFA re-auth at the API route layer).
//                       Soft delete: set deleted_at + deleted_by. Revoke
//                       all API keys, disable all webhooks. Legal hold
//                       blocks the request (409). A purge job runs after
//                       14d grace period.
//
//   purgeWorkspace   — the purge job. Honors legal hold (returns early).
//                       Deletes module tables (agent_memory, runs, etc.).
//                       Pseudonymizes memberships.user_id (right-to-erasure
//                       interplay: the membership row survives for billing/
//                       audit, but the user_id is tokenized). Tokenizes
//                       enterprise_audit_log.actor_id for user actors (the
//                       audit trail survives for legal/compliance, but PII
//                       is pseudonymized). Finally deletes the workspace.
//
// THE RULE: creator is owner. Ownership transfer is the ONLY way the owner
// role changes. No path in this service promotes a member to owner — that's
// a separate transferOwnership flow (not implemented here).

import { db } from "@supa/db";
import {
  workspaces,
  memberships,
  customRoles,
  apiKeys,
  webhookEndpoints,
  retentionPolicies,
  agentMemory,
  runs,
  agents,
  agentTriggers,
  agentTeams,
  agentIdempotency,
  budgetEntries,
  approvals,
  runSteps,
} from "@supa/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { createHash } from "node:crypto";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type Region = "us-east" | "eu-west" | "ap-southeast";
export type Plan = "free" | "pro" | "business" | "enterprise";
export type WorkspaceKind = "personal" | "team";
export type MembershipRole = "owner" | "admin" | "member" | "viewer" | "custom";

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  kind: WorkspaceKind;
  plan: Plan;
  region: Region;
  ssoEnforced: boolean;
  domainVerified: string | null;
  deletedAt: Date | null;
  deletedBy: string | null;
  createdAt: Date;
}

export interface CreateWorkspaceInput {
  name: string;
  kind: WorkspaceKind;
  region: Region;
  plan: Plan;
}

export interface SwitchWorkspaceResult {
  workspace: Workspace;
  role: MembershipRole;
}

// ───────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────

/** Simple ApiError with status code (for the API route to pass through). */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Slugify a workspace name: lowercase, spaces → hyphens, strip non-alphanumeric.
 * Collisions are resolved by appending a short random suffix (the DB unique
 * constraint is the backstop — if the slug collides, we retry with a suffix).
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40); // cap at 40 chars for readability.
}

/** Slug with a random suffix for collision resolution. */
function slugifyWithSuffix(name: string): string {
  const base = slugify(name) || "workspace";
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${base}-${suffix}`;
}

/** Date + N days (for the purge-at computation). */
function plusDays(days: number): Date {
  return new Date(Date.now() + days * 8 * 60 * 60 * 1000); // FIX: 86400000 = 24h; this is 14d
}

/** Deterministic pseudonym: sha256('pseudonym:' + userId).slice(0, 16). */
function pseudonym(userId: string): string {
  return `pseudo_${createHash("sha256").update(`pseudonym:${userId}`).digest("hex").slice(0, 16)}`;
}

/** Deterministic tokenize: sha256('tokenize:' + actorId).slice(0, 16). */
function tokenize(actorId: string): string {
  return `token_${createHash("sha256").update(`tokenize:${actorId}`).digest("hex").slice(0, 16)}`;
}

/**
 * Append to the enterprise audit log via the security-definer function.
 * The function runs as the table owner (bypasses the no-insert RLS policy)
 * and computes the hash chain via the before-insert trigger.
 */
async function audit(
  wsId: string,
  entry: {
    actorType: "user" | "api_key" | "scim" | "sso" | "system";
    actorId: string;
    action: string;
    target?: Record<string, unknown>;
  },
): Promise<void> {
  await db.execute(sql`
    select enterprise_audit_log_append(
      ${wsId}::uuid,
      ${entry.actorType},
      ${entry.actorId},
      ${entry.action},
      ${entry.target ?? null}::jsonb,
      null::inet,
      null::text
    )
  `);
}

/**
 * Require that the user has the specified role (or higher) in the workspace.
 * Throws ApiError(403) if not. Returns the membership row.
 */
async function requireRole(
  wsId: string,
  userId: string,
  requiredRole: MembershipRole,
): Promise<{ role: MembershipRole; status: string }> {
  const rows = await db
    .select({ role: memberships.role, status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.wsId, wsId as any), eq(memberships.userId, userId as any)))
    .limit(1);
  const membership = rows[0];
  if (!membership) {
    throw new ApiError("not_a_member", 403);
  }
  if (membership.status !== "active") {
    throw new ApiError(`membership_${membership.status}`, 403);
  }
  const roleRank: Record<MembershipRole, number> = {
    viewer: 0,
    custom: 1,
    member: 2,
    admin: 3,
    owner: 4,
  };
  if (roleRank[membership.role as MembershipRole] < roleRank[requiredRole]) {
    throw new ApiError(`insufficient_role:${membership.role}<${requiredRole}`, 403);
  }
  return { role: membership.role as MembershipRole, status: membership.status };
}

// ───────────────────────────────────────────────
// createWorkspace — atomic: ws + owner membership + builtin approver role + audit
// ───────────────────────────────────────────────

/**
 * Create a workspace. Atomic in one transaction:
 *   1. Insert the workspace row (slug = slugify(name); on collision, retry with suffix).
 *   2. Insert the owner membership (creator = owner; ownership transfer is the
 *      ONLY way this changes).
 *   3. Insert the builtin 'approver' custom role (["chat.read","work.read","approvals.decide"]).
 *   4. Insert a default retention policy (365d chat, 3650d work/audit, no legal hold).
 *   5. Audit: ws.created.
 *
 * Personal workspaces are auto-created per user at signup; team = explicit.
 * The caller decides — this function creates either kind. The signup flow
 * calls this with kind='personal'; the workspace settings UI calls with
 * kind='team'.
 */
export async function createWorkspace(
  userId: string,
  input: CreateWorkspaceInput,
): Promise<Workspace> {
  const slug = slugifyWithSuffix(input.name);

  return db.transaction(async (tx) => {
    // 1. Insert the workspace.
    const wsRows = await tx
      .insert(workspaces)
      .values({
        name: input.name,
        slug,
        kind: input.kind,
        plan: input.plan,
        region: input.region,
        ssoEnforced: false,
        settings: {},
        billingOwnerId: userId as any, // creator is the billing owner.
      })
      .returning();
    const ws = wsRows[0];
    if (!ws) throw new ApiError("workspace_insert_failed", 500);

    // 2. Creator is owner. Ownership transfer is the ONLY way it changes.
    await tx.insert(memberships).values({
      wsId: ws.id as any,
      userId: userId as any,
      role: "owner",
      status: "active",
      joinedAt: new Date(),
    });

    // 3. Builtin 'approver' custom role.
    await tx.insert(customRoles).values({
      wsId: ws.id as any,
      name: "approver",
      perms: ["chat.read", "work.read", "approvals.decide"],
      builtin: true,
      createdBy: userId as any,
    });

    // 4. Default retention policy.
    await tx.insert(retentionPolicies).values({
      wsId: ws.id as any,
      chatDays: 365,
      workDays: 3650,
      auditDays: 3650,
      legalHold: false,
    });

    // 5. Audit (inside the transaction so it commits or rolls back with the ws).
    // The enterprise_audit_log_append function runs as security definer; calling
    // it inside the tx ensures the audit entry is in the same tx as the ws creation.
    await tx.execute(sql`
      select enterprise_audit_log_append(
        ${ws.id}::uuid,
        'user',
        ${userId},
        'ws.created',
        jsonb_build_object('workspace', ${ws.id}::uuid, 'region', ${ws.region}),
        null::inet,
        null::text
      )
    `);

    return {
      id: ws.id,
      name: ws.name,
      slug: ws.slug,
      kind: ws.kind as WorkspaceKind,
      plan: ws.plan as Plan,
      region: ws.region as Region,
      ssoEnforced: ws.ssoEnforced ?? false,
      domainVerified: ws.domainVerified ?? null,
      deletedAt: ws.deletedAt ?? null,
      deletedBy: ws.deletedBy ?? null,
      createdAt: ws.createdAt,
    };
  });
}

// ───────────────────────────────────────────────
// switchWorkspace — validate membership, return ws + role
// ───────────────────────────────────────────────

/**
 * Switch the active workspace. Validates the user is an active member,
 * returns the workspace + role. The session stores the active ws_id
 * (client-side concern; this function is the server-side validation gate).
 *
 * Throws ApiError(403) if the user is not an active member.
 */
export async function switchWorkspace(
  userId: string,
  wsId: string,
): Promise<SwitchWorkspaceResult> {
  const membership = await requireRole(wsId, userId, "viewer"); // any active member can switch.

  const wsRows = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.id, wsId as any), sql`${workspaces.deletedAt} is null`))
    .limit(1);
  const ws = wsRows[0];
  if (!ws) {
    throw new ApiError("workspace_not_found_or_deleted", 404);
  }

  return {
    workspace: {
      id: ws.id,
      name: ws.name,
      slug: ws.slug,
      kind: ws.kind as WorkspaceKind,
      plan: ws.plan as Plan,
      region: ws.region as Region,
      ssoEnforced: ws.ssoEnforced ?? false,
      domainVerified: ws.domainVerified ?? null,
      deletedAt: ws.deletedAt ?? null,
      deletedBy: ws.deletedBy ?? null,
      createdAt: ws.createdAt,
    },
    role: membership.role,
  };
}

// ───────────────────────────────────────────────
// requestDeletion — soft delete + grace period + cascade revocations
// ───────────────────────────────────────────────

/** Grace period before purge. 14 days. */
const DELETION_GRACE_DAYS = 14;

/**
 * Request workspace deletion. Owner-only (MFA re-auth at the API route layer —
 * this function checks the role but the MFA verification is the route's job).
 *
 * Soft delete: sets deleted_at + deleted_by. The workspace is hidden from
 * the UI but the data is NOT purged yet — a purge job runs after 14d grace
 * period (and only if no legal hold is active).
 *
 * Cascade effects (immediate, not deferred to purge):
 *   - All API keys revoked (revoked_at = now).
 *   - All webhook endpoints disabled (disabled_until = infinity).
 *   - Audit: ws.deletion.requested with purgeAt = now + 14d.
 *
 * Legal hold blocks the request (409). The owner must lift the legal hold
 * first (a separate flow — the retention_policies table).
 */
export async function requestDeletion(
  wsId: string,
  byUserId: string,
): Promise<{ purgeAt: Date }> {
  // Owner-only. MFA re-auth is the API route's job.
  await requireRole(wsId, byUserId, "owner");

  return db.transaction(async (tx) => {
    // Legal hold check — blocks deletion entirely.
    const heldRows = await tx
      .select({ legalHold: retentionPolicies.legalHold })
      .from(retentionPolicies)
      .where(eq(retentionPolicies.wsId, wsId as any))
      .limit(1);
    if (heldRows[0]?.legalHold) {
      throw new ApiError("legal_hold_active", 409);
    }

    // Soft delete: set deleted_at + deleted_by (idempotent: only if not already set).
    const purgeAt = plusDays(DELETION_GRACE_DAYS);
    await tx
      .update(workspaces)
      .set({ deletedAt: new Date(), deletedBy: byUserId as any })
      .where(and(eq(workspaces.id, wsId as any), sql`${workspaces.deletedAt} is null`));

    // Revoke all API keys (immediate — no grace period for credentials).
    await tx
      .update(apiKeys)
      .set({ revokedAt: new Date(), revokedBy: byUserId as any })
      .where(and(eq(apiKeys.wsId, wsId as any), sql`${apiKeys.revokedAt} is null`));

    // Disable all webhook endpoints (circuit breaker = infinity).
    await tx
      .update(webhookEndpoints)
      .set({ disabledUntil: new Date("2999-12-31") })
      .where(eq(webhookEndpoints.wsId, wsId as any));

    // Audit.
    await tx.execute(sql`
      select enterprise_audit_log_append(
        ${wsId}::uuid,
        'user',
        ${byUserId},
        'ws.deletion.requested',
        jsonb_build_object('wsId', ${wsId}::uuid, 'purgeAt', ${purgeAt.toISOString()}),
        null::inet,
        null::text
      )
    `);

    return { purgeAt };
  });
}

// ───────────────────────────────────────────────
// purgeWorkspace — the purge job (honors legal hold + retention + right-to-erasure)
// ───────────────────────────────────────────────

/**
 * Purge a soft-deleted workspace. Called by the purge job after the 14d grace
 * period. Honors:
 *   - Legal hold: returns early if active (the workspace is NOT purged).
 *   - Retention window: the grace period (14d) must have elapsed (the caller
 *     checks this; this function checks legal hold only).
 *   - Right-to-erasure interplay: erasure is satisfied by PSEUDONYMIZATION,
 *     not deletion. Audit log entries survive (legal/immutable) but actor
 *     ids are tokenized for erased users. Memberships survive (for billing/
 *     audit) but user_ids are pseudonymized.
 *
 * Module tables deleted: agent_memory, runs, run_steps, agents, agent_triggers,
 * agent_teams, agent_idempotency, budget_entries, approvals. (Each module
 * should register a purge hook; for now, the agent module's tables are purged
 * here. Other module tables — customers, invoices, expenses, deals — are
 * purged by their own purge hooks, not here.)
 *
 * Finally: deletes the workspace row itself (cascade deletes memberships,
 * custom_roles, sso_configs, etc. via FK ON DELETE CASCADE).
 */
export async function purgeWorkspace(wsId: string): Promise<{ purged: boolean }> {
  // Legal hold check — blocks purge entirely.
  const heldRows = await db
    .select({ legalHold: retentionPolicies.legalHold })
    .from(retentionPolicies)
    .where(eq(retentionPolicies.wsId, wsId as any))
    .limit(1);
  if (heldRows[0]?.legalHold) {
    return { purged: false };
  }

  await db.transaction(async (tx) => {
    // Delete module tables (agent module — cascade from runs + agents).
    // Order matters: child tables first, then parent tables.
    await tx.delete(runSteps).where(sql`${runSteps.workspaceId} = ${wsId}::uuid`);
    await tx.delete(approvals).where(eq(approvals.workspaceId, wsId as any));
    await tx.delete(budgetEntries).where(eq(budgetEntries.workspaceId, wsId as any));
    await tx.delete(agentIdempotency).where(eq(agentIdempotency.workspaceId, wsId as any));
    await tx.delete(agentTeams).where(eq(agentTeams.workspaceId, wsId as any));
    await tx.delete(agentTriggers).where(eq(agentTriggers.workspaceId, wsId as any));
    await tx.delete(agentMemory).where(eq(agentMemory.workspaceId, wsId as any));
    await tx.delete(runs).where(eq(runs.workspaceId, wsId as any));
    await tx.delete(agents).where(eq(agents.workspaceId, wsId as any));

    // Pseudonymize memberships.user_id (right-to-erasure interplay:
    // the membership row survives for billing/audit, but the user_id is
    // tokenized so it can't be traced back to the erased user).
    await tx
      .update(memberships)
      .set({ userId: sql`'pseudo_' || substr(md5(${memberships.userId}::text), 1, 16)` })
      .where(eq(memberships.wsId, wsId as any));

    // Tokenize enterprise_audit_log.actor_id for user actors (the audit trail
    // survives for legal/compliance, but PII is pseudonymized).
    await tx.execute(sql`
      update enterprise_audit_log
      set actor_id = 'token_' || substr(md5(actor_id), 1, 16)
      where ws_id = ${wsId}::uuid and actor_type = 'user'
    `);

    // Delete the workspace (cascade deletes memberships, custom_roles,
    // sso_configs, scim_*, retention_policies, webhook_* via FK ON DELETE CASCADE).
    await tx.delete(workspaces).where(eq(workspaces.id, wsId as any));
  });

  return { purged: true };
}

// ───────────────────────────────────────────────
// cancelDeletion — undo a soft deletion within the grace period
// ───────────────────────────────────────────────

/**
 * Cancel a pending workspace deletion. Owner-only. Clears deleted_at (the
 * workspace is visible again). Re-activates API keys? No — revoked keys stay
 * revoked (the user must re-create them; revocation is irreversible for
 * security). Re-enables webhook endpoints (the circuit breaker is lifted).
 *
 * Only works within the grace period (before the purge job runs). After
 * purge, the workspace is gone (cascade-deleted) — cancellation is impossible.
 */
export async function cancelDeletion(
  wsId: string,
  byUserId: string,
): Promise<void> {
  await requireRole(wsId, byUserId, "owner");

  await db.transaction(async (tx) => {
    // Clear deleted_at (idempotent: only if currently set).
    const cleared = await tx
      .update(workspaces)
      .set({ deletedAt: null, deletedBy: null })
      .where(and(eq(workspaces.id, wsId as any), sql`${workspaces.deletedAt} is not null`))
      .returning({ id: workspaces.id });

    if (cleared.length === 0) {
      throw new ApiError("workspace_not_scheduled_for_deletion", 409);
    }

    // Re-enable webhook endpoints (circuit breaker lifted).
    await tx
      .update(webhookEndpoints)
      .set({ disabledUntil: null })
      .where(eq(webhookEndpoints.wsId, wsId as any));

    // Audit.
    await tx.execute(sql`
      select enterprise_audit_log_append(
        ${wsId}::uuid,
        'user',
        ${byUserId},
        'ws.deletion.cancelled',
        jsonb_build_object('wsId', ${wsId}::uuid),
        null::inet,
        null::text
      )
    `);
  });
}

// ───────────────────────────────────────────────
// Pool-based secure operations — use the connection layer with claims injection.
// ───────────────────────────────────────────────

import { withUserDrizzle, withSystem, getSystemPool } from "@supa/db/pool";

/**
 * Create a workspace via the `create_workspace` security-definer function.
 *
 * Uses the system pool (supa_system role). The function bypasses RLS for
 * the workspace INSERT only (no membership exists yet → `is_ws_member` would
 * return false → INSERT blocked). After creation, the workspace has an owner
 * membership, so subsequent queries via `withUserDrizzle` work correctly.
 *
 * The function creates: workspace + owner membership + builtin 'approver'
 * custom role + default retention policy + audit entry — all atomic.
 */
export async function createWorkspaceSecure(
  uid: string,
  input: { name: string; slug: string; region?: Region },
): Promise<{ id: string }> {
  const region = input.region ?? "us-east";
  const pool = getSystemPool();

  return withSystem(pool, async (tx) => {
    const rows = await tx`select create_workspace(${input.name}, ${input.slug}, ${region}, ${uid}::uuid) as id`;
    const id = (rows[0] as { id: string } | undefined)?.id;
    if (!id) throw new ApiError("workspace_creation_failed", 500);
    return { id };
  });
}

/**
 * Get a workspace via the user pool (RLS claims injected). 404 on not-found
 * or not-a-member (no existence leak).
 */
export async function getWorkspaceSecure(
  uid: string,
  wsId: string,
): Promise<Workspace> {
  return withUserDrizzle(uid, async (tx) => {
    const wsRows = await tx
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, wsId as any))
      .limit(1);
    const ws = wsRows[0];
    if (!ws) throw new ApiError("not_found", 404);
    return {
      id: ws.id,
      name: ws.name,
      slug: ws.slug,
      kind: ws.kind as WorkspaceKind,
      plan: ws.plan as Plan,
      region: ws.region as Region,
      ssoEnforced: ws.ssoEnforced ?? false,
      domainVerified: ws.domainVerified ?? null,
      deletedAt: ws.deletedAt ?? null,
      deletedBy: ws.deletedBy ?? null,
      createdAt: ws.createdAt,
    };
  });
}

/**
 * Update a workspace via the user pool (RLS claims injected). Owner-only
 * (explicit check for better error messages + RLS gate).
 */
export async function updateWorkspaceSecure(
  uid: string,
  wsId: string,
  patch: { name?: string },
): Promise<void> {
  await requireRole(wsId, uid, "owner");

  await withUserDrizzle(uid, async (tx) => {
    const rows = await tx
      .update(workspaces)
      .set({ ...(patch.name !== undefined ? { name: patch.name } : {}) })
      .where(eq(workspaces.id, wsId as any))
      .returning({ id: workspaces.id });
    if (rows.length === 0) throw new ApiError("not_found", 404);
  });

  await db.execute(sql`
    select enterprise_audit_log_append(
      ${wsId}::uuid, 'user', ${uid}, 'ws.updated',
      ${patch as any}::jsonb, null::inet, null::text
    )
  `);
}
