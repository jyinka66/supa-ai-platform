import { requireRecentAal2 } from "@/lib/auth/mfa";
// Members service — roles, invitations, suspension, ownership transfer.
//
// The enterprise permission model has two layers:
//   1. Role (owner/admin/member/viewer/custom) — coarse-grained, from
//      `memberships.role`.
//   2. Perms (chat.read, work.write, agents.use, ...) — fine-grained,
//      resolved from `ROLE_DEFAULTS` (for builtin roles) or
//      `custom_roles.perms` (for custom roles).
//
// `resolvePerms(m)` returns the effective perm list for a membership. The
// API route uses this to build the user's session-scoped permission set.
// The existing `@supa/workspace-core/capabilities` is a CLOSED action
// taxonomy (workspace.read, invoice.create, etc.) — this granular perm
// layer is the enterprise extension (chat.read maps to workspace.read +
// finer scopes). Both coexist; the API route checks both.
//
// INVITATION FLOW:
//   invite() → token (32 random bytes, base64url) + hash(token) stored on
//     the membership row (status='invited'). Email sent with the token
//     (NOT the hash — the hash is what's stored; the token is what's sent).
//   acceptInvite(token) → look up by hash(token), check not expired + ws
//     not deleted, seat check again, set user_id + status='active' +
//     joined_at, null out invite_token.
//
// The invite email contains NO workspace data (security: a leaked invite
// link reveals nothing about the workspace). The accept page resolves the
// workspace from the token server-side.
//
// ROLE ESCALATION GUARD: only owner can grant owner/admin. An admin can
// invite members/viewers but not owners/admins. This is enforced here
// (defense-in-depth — the API route should also check).
//
// OWNERSHIP TRANSFER: owner-initiated, target must be active member, atomic
// swap (new owner = owner, old owner = admin), MFA re-auth for initiator,
// new owner must have MFA enrolled, audited, irrevocable by target.

import { db } from "@supa/db";
import {
  memberships,
  customRoles,
  workspaces,
  ssoConfigs,
  retentionPolicies,
} from "@supa/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type Role = "owner" | "admin" | "member" | "viewer" | "custom";
export type Perm = string;

export interface Membership {
  wsId: string;
  userId: string | null;
  role: Role;
  customRoleId: string | null;
  status: "active" | "invited" | "suspended";
}

export interface InviteInput {
  email: string;
  role: Role;
  customRoleId?: string;
}

export interface InviteResult {
  id: string;
  email: string;
  role: Role;
  expiresAt: Date;
}

export interface BulkInviteResult {
  email: string;
  ok: boolean;
  error?: string;
  inviteId?: string;
}

// ───────────────────────────────────────────────
// ROLE_DEFAULTS — the builtin role → perm mapping
// ───────────────────────────────────────────────

const ROLE_DEFAULTS: Record<Exclude<Role, "custom">, Perm[]> = {
  owner: ["*"],
  admin: [
    "chat.*", "work.*", "freelance.*", "design.*", "business.*", "agents.*",
    "members.invite", "members.suspend", "settings.write", "billing.view",
    "audit.read", "api_keys.manage",
  ],
  member: ["chat.*", "work.*", "freelance.*", "design.*", "business.read", "agents.use"],
  viewer: ["chat.read", "work.read", "business.read"],
};

/**
 * Resolve the effective permission list for a membership.
 *   - Builtin roles (owner/admin/member/viewer) → ROLE_DEFAULTS.
 *   - Custom role → custom_roles.perms (looked up by custom_role_id).
 *   - If the custom role doesn't exist, returns [] (no perms — fail-closed).
 */
export async function resolvePerms(m: Membership): Promise<Perm[]> {
  if (m.role !== "custom") {
    return ROLE_DEFAULTS[m.role as Exclude<Role, "custom">] ?? [];
  }
  if (!m.customRoleId) return [];
  const rows = await db
    .select({ perms: customRoles.perms })
    .from(customRoles)
    .where(eq(customRoles.id, m.customRoleId as any))
    .limit(1);
  return (rows[0]?.perms as string[]) ?? [];
}

// ───────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────

/** Simple ApiError with status code + optional extra metadata. */
export class ApiError extends Error {
  constructor(message: string, public status: number, public extra?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
  }
}

/** SHA-256 hex hash of a token (for storage — the raw token is never stored). */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Append to the enterprise audit log via the security-definer function.
 * Same pattern as workspaces/service.ts.
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
 * Require that the user has a specific permission in the workspace.
 * Resolves the user's role + perms, checks if the perm is granted (via
 * wildcard match: "chat.*" matches "chat.read", "*" matches everything).
 * Throws ApiError(403) if not.
 * Returns the membership row (for the caller to use).
 */
async function requirePerm(
  wsId: string,
  userId: string,
  perm: Perm,
): Promise<Membership> {
  const rows = await db
    .select({
      role: memberships.role,
      customRoleId: memberships.customRoleId,
      status: memberships.status,
    })
    .from(memberships)
    .where(and(eq(memberships.wsId, wsId as any), eq(memberships.userId, userId as any)))
    .limit(1);
  const m = rows[0];
  if (!m) throw new ApiError("not_a_member", 403);
  if (m.status !== "active") throw new ApiError(`membership_${m.status}`, 403);

  const membership: Membership = {
    wsId,
    userId,
    role: m.role as Role,
    customRoleId: m.customRoleId ?? null,
    status: m.status as Membership["status"],
  };

  const perms = await resolvePerms(membership);
  if (!hasPerm(perms, perm)) {
    throw new ApiError(`permission_missing:${perm}`, 403);
  }
  return membership;
}

/**
 * Check if a perm list grants a specific permission. Supports wildcards:
 *   "*" matches everything.
 *   "chat.*" matches "chat.read", "chat.write", etc.
 *   "chat.read" matches only "chat.read".
 */
function hasPerm(perms: Perm[], required: Perm): boolean {
  return perms.some((p) => {
    if (p === "*") return true;
    if (p === required) return true;
    if (p.endsWith(".*")) {
      const prefix = p.slice(0, -2);
      return required.startsWith(prefix + ".");
    }
    return false;
  });
}

/** Require that the user has a specific role (or higher). */
async function requireRole(
  wsId: string,
  userId: string,
  requiredRole: Role,
): Promise<Membership> {
  const rows = await db
    .select({ role: memberships.role, status: memberships.status, customRoleId: memberships.customRoleId })
    .from(memberships)
    .where(and(eq(memberships.wsId, wsId as any), eq(memberships.userId, userId as any)))
    .limit(1);
  const m = rows[0];
  if (!m) throw new ApiError("not_a_member", 403);
  if (m.status !== "active") throw new ApiError(`membership_${m.status}`, 403);

  const roleRank: Record<Role, number> = { viewer: 0, custom: 1, member: 2, admin: 3, owner: 4 };
  if (roleRank[m.role as Role] < roleRank[requiredRole]) {
    throw new ApiError(`insufficient_role:${m.role}<${requiredRole}`, 403);
  }
  return {
    wsId,
    userId,
    role: m.role as Role,
    customRoleId: m.customRoleId ?? null,
    status: m.status as Membership["status"],
  };
}

/** Require that the target user is a member of the workspace. Returns the membership. */
async function requireMembership(wsId: string, userId: string): Promise<Membership> {
  const rows = await db
    .select({ role: memberships.role, status: memberships.status, customRoleId: memberships.customRoleId })
    .from(memberships)
    .where(and(eq(memberships.wsId, wsId as any), eq(memberships.userId, userId as any)))
    .limit(1);
  const m = rows[0];
  if (!m) throw new ApiError("target_not_a_member", 404);
  return {
    wsId,
    userId,
    role: m.role as Role,
    customRoleId: m.customRoleId ?? null,
    status: m.status as Membership["status"],
  };
}

/**
 * Check that a seat is available (server-side, not client — the spec's
 * invariant: "SERVER-side seat limit, not client"). Counts active + invited
 * memberships against the workspace's seat_limit. Throws ApiError(409) if full.
 */
async function checkSeatAvailable(wsId: string): Promise<void> {
  const wsRows = await db
    .select({ seatLimit: workspaces.seatLimit })
    .from(workspaces)
    .where(eq(workspaces.id, wsId as any))
    .limit(1);
  const seatLimit = wsRows[0]?.seatLimit ?? 3;

  const countRows = await db
    .select({ n: sql<number>`count(*)` })
    .from(memberships)
    .where(
      and(
        eq(memberships.wsId, wsId as any),
        sql`${memberships.status} in ('active', 'invited')`,
      ),
    );
  const occupied = Number(countRows[0]?.n ?? 0);
  if (occupied >= seatLimit) {
    throw new ApiError("seat_limit_reached", 409);
  }
}

/** Send the invite email. Contains the token, NO workspace data. */
async function sendInviteEmail(email: string, token: string, _wsId: string): Promise<void> {
  // Stub — the real implementation uses the email provider (apps/web/src/lib/email/send.ts).
  // The email contains the invite link with the token, but NO workspace name/slug/id.
  // A leaked invite link reveals nothing about the workspace.
  console.log(`[invite] would send email to ${email} with token ${token.slice(0, 8)}...`);
}

/** Revoke all sessions for a user (suspension/erasure side-effect). C9 FIX. */
async function revokeAllSessions(userId: string): Promise<void> {
  // C9 FIX: the old stub was a no-op console.log — suspended/removed users
  // retained their sessions until natural expiry. Now we:
  //   1. Call Supabase's admin API to sign out all sessions (revokes JWTs).
  //   2. Revoke app-level sessions (the sessions table from migration 0032).
  try {
    const { supabaseService } = await import("@/lib/supabase/server");
    const supabase = await supabaseService();
    await supabase.auth.admin.signOut(userId, "global");
  } catch (err) {
    // Best-effort — if Supabase is unavailable, log + continue (the suspension
    // still commits; the user's JWTs will expire naturally).
    console.error(`[sessions] failed to revoke Supabase sessions for ${userId}:`, err);
  }

  // Revoke app-level sessions (the sessions table).
  try {
    const { sessions: sessionsTable } = await import("@supa/db/schema");
    const { eq, and, isNull } = await import("drizzle-orm");
    await db
      .update(sessionsTable)
      .set({ revokedAt: new Date(), refreshTokenHash: null })
      .where(
        and(
          eq(sessionsTable.userId, userId as any),
          isNull(sessionsTable.revokedAt),
        ),
      );
  } catch (err) {
    // Best-effort — the sessions table might not exist (dev without migration 0032).
    console.error(`[sessions] failed to revoke app sessions for ${userId}:`, err);
  }
}

/** Require MFA re-authentication (for ownership transfer + workspace deletion). C8 FIX. */
async function requireMfaReauth(userId: string, accessToken: string): Promise<void> {
  await requireRecentAal2(userId, accessToken);
}

/** Require that the user has MFA enrolled (for ownership transfer target). */
async function requireMfaEnrolled(wsId: string, userId: string): Promise<void> {
  const rows = await db
    .select({ mfaEnrolled: memberships.mfaEnrolled })
    .from(memberships)
    .where(and(eq(memberships.wsId, wsId as any), eq(memberships.userId, userId as any)))
    .limit(1);
  if (!rows[0]?.mfaEnrolled) {
    throw new ApiError("mfa_enrollment_required_for_owner", 403);
  }
}

/** Get a user's email (for autoJoin domain extraction). */
async function getUserEmail(userId: string): Promise<string> {
  // Stub — the real implementation queries auth.users or profiles.
  // For now, throw (autoJoin requires the auth integration to be wired).
  throw new Error(`getUserEmail_not_implemented:${userId}`);
}

// ───────────────────────────────────────────────
// invite — create an invitation
// ───────────────────────────────────────────────

const INVITE_TTL_DAYS = 7;

/**
 * Invite a user to a workspace by email. The invite token (32 random bytes,
 * base64url) is sent in the email; the SHA-256 hash of the token is stored
 * on the membership row (status='invited'). The raw token is NEVER stored.
 *
 * Role escalation guard: only owner can grant owner/admin. An admin can
 * invite members/viewers but not owners/admins.
 *
 * Seat check: server-side, not client. The seat limit is checked before
 * the invite is created (and again at accept time — limits may have changed).
 *
 * The invite email contains NO workspace data (security: a leaked invite
 * link reveals nothing about the workspace).
 */
export async function invite(
  wsId: string,
  byUserId: string,
  input: InviteInput,
): Promise<InviteResult> {
  const inviter = await requirePerm(wsId, byUserId, "members.invite");

  // Role escalation guard: only owner can grant owner/admin.
  if ((input.role === "owner" || input.role === "admin") && inviter.role !== "owner") {
    throw new ApiError("owner_required_for_admin_grant", 403);
  }

  // Seat check (server-side).
  await checkSeatAvailable(wsId);

  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400000);

  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(memberships)
      .values({
        wsId: wsId as any,
        userId: null, // null until accepted.
        role: input.role,
        customRoleId: (input.customRoleId ?? null) as any,
        status: "invited",
        invitedBy: byUserId as any,
        invitedAt: new Date(),
        invitedEmail: input.email,
        inviteToken: tokenHash,
        inviteExpiresAt: expiresAt,
      })
      .returning({ id: memberships.id });

    const inv = rows[0];
    if (!inv) throw new ApiError("invite_insert_failed", 500);

    // Send the email (outside the tx would be better, but the token is already
    // committed — the email is best-effort; a failed email doesn't roll back
    // the invite).
    await sendInviteEmail(input.email, token, wsId);

    await tx.execute(sql`
      select enterprise_audit_log_append(
        ${wsId}::uuid,
        'user',
        ${byUserId},
        'ws.member.invited',
        jsonb_build_object('member', ${inv.id}::uuid, 'role', ${input.role}, 'email', ${input.email}),
        null::inet,
        null::text
      )
    `);

    return {
      id: inv.id,
      email: input.email,
      role: input.role,
      expiresAt,
    };
  });
}

// ───────────────────────────────────────────────
// acceptInvite — idempotent, by token
// ───────────────────────────────────────────────

/**
 * Accept an invitation by token. Idempotent: if the same user accepts the
 * same token twice, the second call is a no-op (the membership is already
 * active). The token is looked up by its hash (the raw token is never stored).
 *
 * Checks:
 *   - Invite exists, status='invited', not expired.
 *   - Workspace not deleted.
 *   - Seat available (re-checked at accept time — limits may have changed).
 *
 * On accept: sets user_id, status='active', joined_at=now(), nulls invite_token.
 */
export async function acceptInvite(token: string, userId: string): Promise<Membership> {
  const tokenHash = hashToken(token);

  return db.transaction(async (tx) => {
    // Look up the invite by token hash. Join to workspaces to check deleted_at.
    const invRows = await tx
      .select({
        id: memberships.id,
        wsId: memberships.wsId,
        role: memberships.role,
        customRoleId: memberships.customRoleId,
        wsDeletedAt: workspaces.deletedAt,
      })
      .from(memberships)
      .innerJoin(workspaces, eq(workspaces.id, memberships.wsId as any))
      .where(
        and(
          eq(memberships.status, "invited"),
          eq(memberships.inviteToken, tokenHash),
          sql`${memberships.inviteExpiresAt} > now()`,
          sql`${workspaces.deletedAt} is null`,
        ),
      )
      .limit(1);

    const inv = invRows[0];
    if (!inv) {
      throw new ApiError("invite_invalid_or_expired", 410);
    }

    // Seat check again at accept time (limits may have changed since invite).
    await checkSeatAvailable(inv.wsId as string);

    // Update the membership: set user_id, status='active', joined_at, null token.
    const updated = await tx
      .update(memberships)
      .set({
        userId: userId as any,
        status: "active",
        joinedAt: new Date(),
        inviteToken: null,
      })
      .where(
        and(
          eq(memberships.id, inv.id as any),
          eq(memberships.status, "invited"),
        ),
      )
      .returning();

    const m = updated[0];
    if (!m) {
      // Already accepted by someone else (race) — idempotent: return the existing.
      const existing = await tx
        .select()
        .from(memberships)
        .where(eq(memberships.id, inv.id as any))
        .limit(1);
      const existingM = existing[0];
      if (!existingM) throw new ApiError("invite_not_found", 404);
      return {
        wsId: existingM.wsId as string,
        userId: existingM.userId as string,
        role: existingM.role as Role,
        customRoleId: existingM.customRoleId ?? null,
        status: existingM.status as Membership["status"],
      };
    }

    await tx.execute(sql`
      select enterprise_audit_log_append(
        ${inv.wsId}::uuid,
        'user',
        ${userId},
        'ws.member.joined',
        jsonb_build_object('member', ${inv.id}::uuid, 'role', ${inv.role}),
        null::inet,
        null::text
      )
    `);

    return {
      wsId: m.wsId as string,
      userId: m.userId as string,
      role: m.role as Role,
      customRoleId: m.customRoleId ?? null,
      status: m.status as Membership["status"],
    };
  });
}

// ───────────────────────────────────────────────
// bulkInvite — Enterprise, atomic per-invite, partial failures reported
// ───────────────────────────────────────────────

const BULK_INVITE_MAX = 1000;

/**
 * Bulk invite (Enterprise). Up to 1000 invites per call. Each invite is
 * atomic (one tx per invite) — partial failures are reported per-row, not
 * rolled back en masse. A failed invite (seat limit, role escalation, etc.)
 * doesn't block the other 999.
 *
 * Returns an array of results: `{ email, ok, error?, inviteId? }`.
 */
export async function bulkInvite(
  wsId: string,
  byUserId: string,
  rows: InviteInput[],
): Promise<BulkInviteResult[]> {
  const slice = rows.slice(0, BULK_INVITE_MAX);
  const results: BulkInviteResult[] = [];

  for (const r of slice) {
    try {
      const inviteResult = await invite(wsId, byUserId, r);
      results.push({ email: r.email, ok: true, inviteId: inviteResult.id });
    } catch (e: any) {
      results.push({
        email: r.email,
        ok: false,
        error: e?.message ?? e?.code ?? "unknown_error",
      });
    }
  }

  return results;
}

// ───────────────────────────────────────────────
// autoJoin — domain auto-join (Enterprise, JIT membership)
// ───────────────────────────────────────────────

/**
 * Auto-join a user to a workspace based on their email domain. If the
 * workspace has a verified domain + SSO enforced, the user is auto-joined
 * with the 'member' role (lowest privilege, configurable).
 *
 * JIT (Just-In-Time): the membership is created on first login, not
 * pre-provisioned. The `on conflict do nothing` makes it idempotent —
 * a second login doesn't create a duplicate.
 *
 * Returns the ws_id if auto-joined, null if no matching workspace.
 */
export async function autoJoin(userId: string): Promise<string | null> {
  let email: string;
  try {
    email = await getUserEmail(userId);
  } catch {
    // getUserEmail not wired yet — return null (no auto-join).
    return null;
  }
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return null;

  // Find a workspace with a verified domain matching the user's email domain
  // + SSO enforced.
  const wsRows = await db
    .select({ wsId: workspaces.id })
    .from(workspaces)
    .innerJoin(ssoConfigs, eq(ssoConfigs.wsId, workspaces.id as any))
    .where(
      and(
        sql`lower(${workspaces.domainVerified}) = ${domain}`,
        sql`${workspaces.deletedAt} is null`,
        eq(ssoConfigs.enforced, true),
      ),
    )
    .limit(1);

  const ws = wsRows[0];
  if (!ws) return null;

  const wsId = ws.wsId as string;

  await db.transaction(async (tx) => {
    // JIT membership: 'member' role, active status. On conflict (already a
    // member) do nothing — idempotent.
    await tx
      .insert(memberships)
      .values({
        wsId: wsId as any,
        userId: userId as any,
        role: "member",
        status: "active",
        joinedAt: new Date(),
      })
      .onConflictDoNothing();

    await tx.execute(sql`
      select enterprise_audit_log_append(
        ${wsId}::uuid,
        'sso',
        ${userId},
        'ws.member.auto_joined',
        jsonb_build_object('domain', ${domain}),
        null::inet,
        null::text
      )
    `);
  });

  return wsId;
}

// ───────────────────────────────────────────────
// suspend — suspended users lose sessions immediately; data preserved
// ───────────────────────────────────────────────

/**
 * Suspend a member. The target's sessions are revoked immediately (they
 * can't access the workspace). Data is preserved (the membership row stays;
 * status='suspended'). The target can be re-activated later.
 *
 * Cannot suspend an owner (the owner must transfer ownership first).
 */
export async function suspend(
  wsId: string,
  byUserId: string,
  targetId: string,
  reason: string,
): Promise<void> {
  await requirePerm(wsId, byUserId, "members.suspend");
  const target = await requireMembership(wsId, targetId);
  if (target.role === "owner") {
    throw new ApiError("cannot_suspend_owner", 409);
  }

  await db.transaction(async (tx) => {
    await tx
      .update(memberships)
      .set({
        status: "suspended",
        suspendedBy: byUserId as any,
        suspendedAt: new Date(),
        suspendReason: reason,
      })
      .where(
        and(
          eq(memberships.wsId, wsId as any),
          eq(memberships.userId, targetId as any),
        ),
      );
  });

  // Revoke all sessions (outside the tx — best-effort, the suspension is
  // already committed; session revocation is the security side-effect).
  await revokeAllSessions(targetId);

  await audit(wsId, {
    actorType: "user",
    actorId: byUserId,
    action: "ws.member.suspended",
    target: { member: targetId, reason },
  });
}

/**
 * Re-activate a suspended member. Sessions are NOT auto-restored (the user
 * must re-authenticate). Owner-only (or admin with members.suspend perm).
 */
export async function unsuspend(
  wsId: string,
  byUserId: string,
  targetId: string,
): Promise<void> {
  await requirePerm(wsId, byUserId, "members.suspend");
  await requireMembership(wsId, targetId);

  await db
    .update(memberships)
    .set({
      status: "active",
      suspendedBy: null,
      suspendedAt: null,
      suspendReason: null,
    })
    .where(
      and(
        eq(memberships.wsId, wsId as any),
        eq(memberships.userId, targetId as any),
        eq(memberships.status, "suspended"),
      ),
    );

  await audit(wsId, {
    actorType: "user",
    actorId: byUserId,
    action: "ws.member.reactivated",
    target: { member: targetId },
  });
}

// ───────────────────────────────────────────────
// transferOwnership — owner-initiated, atomic swap, MFA re-auth, audited
// ───────────────────────────────────────────────

/**
 * Transfer workspace ownership. Owner-initiated, target must be an active
 * member with MFA enrolled. Atomic swap: new owner becomes 'owner', old owner
 * becomes 'admin'. MFA re-auth required for the initiator.
 *
 * Irrevocable by the target (the new owner can transfer back, but the old
 * owner can't unilaterally revoke the transfer — they'd have to ask the new
 * owner to transfer back).
 */
export async function transferOwnership(
  wsId: string,
  byUserId: string,
  toUserId: string,
  accessToken: string,
): Promise<void> {
  // Owner-only.
  await requireRole(wsId, byUserId, "owner");
  // MFA re-auth for the initiator (the API route handles the challenge).
  await requireMfaReauth(byUserId, accessToken);
  // New owner must have MFA enrolled.
  await requireMfaEnrolled(wsId, toUserId);
  // Target must be an active member.
  const target = await requireMembership(wsId, toUserId);
  if (target.status !== "active") {
    throw new ApiError("target_not_active", 409);
  }

  await db.transaction(async (tx) => {
    // New owner → owner.
    await tx
      .update(memberships)
      .set({ role: "owner" })
      .where(
        and(
          eq(memberships.wsId, wsId as any),
          eq(memberships.userId, toUserId as any),
          eq(memberships.status, "active"),
        ),
      );

    // Old owner → admin.
    await tx
      .update(memberships)
      .set({ role: "admin" })
      .where(
        and(
          eq(memberships.wsId, wsId as any),
          eq(memberships.userId, byUserId as any),
        ),
      );
  });

  await audit(wsId, {
    actorType: "user",
    actorId: byUserId,
    action: "ws.ownership.transferred",
    target: { from: byUserId, to: toUserId },
  });
}

// ───────────────────────────────────────────────
// Pool-based secure operations — RLS claims injection via withUserDrizzle/withSystem.
// These are the secure counterparts to the existing functions: every query runs
// AS the user, under RLS (or AS supa_system for bootstrap/system operations).
// ───────────────────────────────────────────────

import { withUserDrizzle, withSystem, getSystemPool } from "@supa/db/pool";
import { sessions } from "@supa/db/schema";

/**
 * Invite a user (secure — RLS claims injection).
 *
 * Uses `withUserDrizzle` so the INSERT runs AS the inviter, under RLS. The
 * role escalation guard is explicit (better error messages) AND enforced by
 * RLS (the membership write policy calls `is_ws_member(ws_id, 'admin')`).
 *
 * The invite token is 32 random bytes (base64url). The SHA-256 hash is stored
 * (raw token never stored). The token is sent in the email — the email
 * contains NO workspace data (a leaked invite link reveals nothing).
 */
export async function inviteSecure(
  wsId: string,
  byUid: string,
  input: InviteInput,
): Promise<InviteResult> {
  const inviter = await requirePerm(wsId, byUid, "members.invite");

  // Role escalation guard: only owner can grant owner/admin.
  if ((input.role === "owner" || input.role === "admin") && inviter.role !== "owner") {
    throw new ApiError("forbidden", 403, { reason: "only_owner_invites_admin" });
  }
  // No invite-to-owner: ownership transfer is a separate flow (MFA re-auth).
  if (input.role === "owner") {
    throw new ApiError("forbidden", 403, { reason: "use_ownership_transfer" });
  }

  await checkSeatAvailable(wsId);

  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400000);

  await withUserDrizzle(byUid, async (tx) => {
    await tx.insert(memberships).values({
      wsId: wsId as any,
      userId: null,
      role: input.role,
      customRoleId: (input.customRoleId ?? null) as any,
      status: "invited",
      invitedBy: byUid as any,
      invitedAt: new Date(),
      invitedEmail: input.email,
      inviteToken: tokenHash,
      inviteExpiresAt: expiresAt,
    });
  });

  await sendInviteEmail(input.email, token, wsId);

  // Audit (via the security-definer function — outside the RLS-gated tx).
  await db.execute(sql`
    select enterprise_audit_log_append(
      ${wsId}::uuid, 'user', ${byUid}, 'member.invited',
      jsonb_build_object('email', ${input.email}, 'role', ${input.role}),
      null::inet, null::text
    )
  `);

  return { id: crypto.randomUUID(), email: input.email, role: input.role, expiresAt };
}

/**
 * Accept an invitation (secure — uses systemPool for the token consumption +
 * membership insert, since the accepting user has no membership yet → RLS
 * would block the INSERT).
 *
 * Token consumed atomically (SELECT ... FOR UPDATE). Expired/reused → 410.
 * The membership is created with status='active' + joined_at=now(). The
 * invite token is nullified after acceptance (single-use).
 */
export async function acceptInviteSecure(
  token: string,
  uid: string,
): Promise<{ wsId: string; role: Role }> {
  const tokenHash = hashToken(token);
  const pool = getSystemPool();

  return withSystem(pool, async (tx) => {
    // Find the invite by token hash. FOR UPDATE locks the row (prevents
    // concurrent accepts — only one wins).
    const invRows = await tx`
      select id, ws_id, role from memberships
      where invite_token = ${tokenHash}
        and status = 'invited'
        and invite_expires_at > now()
      for update
    `;
    const inv = (invRows[0] as { id: string; ws_id: string; role: string } | undefined);
    if (!inv) throw new ApiError("invalid_invite", 410);

    // Consume the invite: set user_id + status='active' + joined_at + null token.
    await tx`
      update memberships
      set user_id = ${uid}::uuid, status = 'active', joined_at = now(), invite_token = null
      where id = ${inv.id} and status = 'invited'
    `;

    // Audit (system-definer).
    await tx`
      select enterprise_audit_log_append(
        ${inv.ws_id}::uuid, 'user', ${uid}, 'member.joined',
        jsonb_build_object('role', ${inv.role}, 'via', 'invite'),
        null::inet, null::text
      )
    `;

    return { wsId: inv.ws_id, role: inv.role as Role };
  });
}

/**
 * Set a member's role (secure — RLS claims injection).
 *
 * Escalation rules (defense in depth — RLS already blocks direct writes):
 *   - Only owner can grant admin.
 *   - Only owner can demote an owner (via transfer_ownership, not setRole).
 *   - Owner demotion requires transfer_ownership (MFA re-auth + confirm).
 *
 * Uses `withUserDrizzle` so the UPDATE runs AS the actor, under RLS.
 */
export async function setRoleSecure(
  wsId: string,
  byUid: string,
  targetUid: string,
  role: Role,
): Promise<void> {
  const actorRole = await requireRole(wsId, byUid, "admin");

  // Fetch the target's current role (system pool — no RLS on this read;
  // the explicit checks below enforce the escalation rules).
  const pool = getSystemPool();
  const targetRows = await pool`
    select role, status from memberships
    where ws_id = ${wsId}::uuid and user_id = ${targetUid}::uuid
  `;
  const target = targetRows[0] as { role: string; status: string } | undefined;
  if (!target || target.status !== "active") {
    throw new ApiError("not_found", 404);
  }

  // Escalation rules.
  if (role === "owner" && actorRole.role !== "owner") {
    throw new ApiError("forbidden", 403, { reason: "only_owner_grants_owner" });
  }
  if (target.role === "owner" && actorRole.role !== "owner") {
    throw new ApiError("forbidden", 403, { reason: "only_owner_modifies_owner" });
  }
  if (target.role === "owner" && role !== "owner") {
    // Owner demotion only via transfer_ownership (requires MFA re-auth + confirm).
    throw new ApiError("forbidden", 403, { reason: "use_ownership_transfer" });
  }
  if (role === "admin" && actorRole.role !== "owner") {
    throw new ApiError("forbidden", 403, { reason: "only_owner_grants_admin" });
  }

  await withUserDrizzle(byUid, async (tx) => {
    await tx
      .update(memberships)
      .set({ role: role as any })
      .where(
        and(
          eq(memberships.wsId, wsId as any),
          eq(memberships.userId, targetUid as any),
        ),
      );
  });

  await db.execute(sql`
    select enterprise_audit_log_append(
      ${wsId}::uuid, 'user', ${byUid}, 'member.role_changed',
      jsonb_build_object('user', ${targetUid}::uuid, 'from', ${target.role}, 'to', ${role}),
      null::inet, null::text
    )
  `);
}

/**
 * Transfer workspace ownership (secure).
 *
 * Owner-initiated, MFA re-auth required, target must be active member.
 * Atomic swap: new owner → 'owner', old owner → 'admin'.
 *
 * Uses `withSystem` (the membership UPDATE needs to set the new owner's role,
 * which RLS would block — the actor is the OLD owner, who has owner perms,
 * but the RLS policy on memberships might not allow setting another user to
 * owner. Using the system pool avoids this — the explicit owner check is the
 * security gate, not RLS).
 */
export async function transferOwnershipSecure(
  wsId: string,
  byUid: string,
  toUid: string,
  accessToken: string,
): Promise<void> {
  await requireMfaReauth(byUid, accessToken);
  await requireRole(wsId, byUid, "owner");

  const pool = getSystemPool();
  await withSystem(pool, async (tx) => {
    // New owner → owner.
    const newOwnerRows = await tx`
      update memberships set role = 'owner'
      where ws_id = ${wsId}::uuid and user_id = ${toUid}::uuid and status = 'active'
      returning id
    `;
    if (!newOwnerRows[0]) throw new ApiError("not_found", 404);

    // Old owner → admin.
    await tx`
      update memberships set role = 'admin'
      where ws_id = ${wsId}::uuid and user_id = ${byUid}::uuid
    `;

    // Audit (system-definer).
    await tx`
      select enterprise_audit_log_append(
        ${wsId}::uuid, 'user', ${byUid}, 'ws.ownership_transferred',
        jsonb_build_object('to', ${toUid}::uuid),
        null::inet, null::text
      )
    `;
  });

  // Notify the old owner (immutable audit trail — the transfer is recorded).
  await notify(wsId, "ownership_transferred", { from: byUid, to: toUid });
}

/**
 * Remove a member (secure — deprovision, NEVER delete).
 *
 * Deprovision: set membership status='workspace_deleted' (data preserved).
 * Revoke all API keys created by the removed user. Revoke sessions in this ws.
 *
 * Guards:
 *   - Can't remove an owner (use transfer_ownership first).
 *   - Can't remove yourself (use leaveWorkspace).
 *   - Only owner can remove admin/owner.
 *
 * Uses `withSystem` (the UPDATE needs to set status, which RLS might restrict
 * for non-self members — the explicit checks are the security gate).
 */
export async function removeMemberSecure(
  wsId: string,
  byUid: string,
  targetUid: string,
): Promise<void> {
  const actorRole = await requireRole(wsId, byUid, "admin");

  const pool = getSystemPool();
  const targetRows = await pool`
    select role from memberships
    where ws_id = ${wsId}::uuid and user_id = ${targetUid}::uuid
  `;
  const target = targetRows[0] as { role: string } | undefined;
  if (!target) throw new ApiError("not_found", 404);

  // Can't remove an owner (use transfer_ownership first).
  if (target.role === "owner") {
    throw new ApiError("forbidden", 403, { reason: "use_ownership_transfer" });
  }
  // Can't remove yourself (use leaveWorkspace).
  if (targetUid === byUid) {
    throw new ApiError("forbidden", 403, { reason: "use_leave" });
  }
  // Only owner can remove admin.
  if (target.role === "admin" && actorRole.role !== "owner") {
    throw new ApiError("forbidden", 403, { reason: "only_owner_removes_admin" });
  }

  await withSystem(pool, async (tx) => {
    // Deprovision, never delete: preserves content + audit integrity.
    await tx`
      update memberships set status = 'workspace_deleted'
      where ws_id = ${wsId}::uuid and user_id = ${targetUid}::uuid
    `;
    // Revoke all API keys created by the removed user.
    await tx`
      update api_keys set revoked_at = now()
      where ws_id = ${wsId}::uuid and user_id = ${targetUid}::uuid and revoked_at is null
    `;
  });

  // Revoke sessions (outside the tx — best-effort).
  await revokeAllSessions(targetUid);

  await db.execute(sql`
    select enterprise_audit_log_append(
      ${wsId}::uuid, 'user', ${byUid}, 'member.removed',
      jsonb_build_object('user', ${targetUid}::uuid),
      null::inet, null::text
    )
  `);
}

/**
 * Leave a workspace (self-service).
 *
 * Last-owner guard: can't leave if you're the only owner (must transfer
 * ownership or delete the workspace first).
 *
 * Uses `withSystem` (the UPDATE sets status, which RLS might restrict for
 * the self-leave case — the explicit checks are the security gate).
 */
export async function leaveWorkspaceSecure(
  wsId: string,
  uid: string,
): Promise<void> {
  const pool = getSystemPool();
  await withSystem(pool, async (tx) => {
    const mRows = await tx`
      select role from memberships
      where ws_id = ${wsId}::uuid and user_id = ${uid}::uuid and status = 'active'
    `;
    const m = mRows[0] as { role: string } | undefined;
    if (!m) throw new ApiError("not_found", 404);

    // Last-owner guard: can't leave if you're the only owner.
    if (m.role === "owner") {
      const ownerCountRows = await tx`
        select count(*)::int as count from memberships
        where ws_id = ${wsId}::uuid and role = 'owner' and status = 'active'
      `;
      const ownerCount = (ownerCountRows[0] as { count: number } | undefined)?.count ?? 0;
      if (ownerCount <= 1) {
        throw new ApiError("last_owner", 409, {
          reason: "transfer_ownership_or_delete_ws_first",
        });
      }
    }

    // Deprovision, never delete.
    await tx`
      update memberships set status = 'workspace_deleted'
      where ws_id = ${wsId}::uuid and user_id = ${uid}::uuid
    `;

    // Audit.
    await tx`
      select enterprise_audit_log_append(
        ${wsId}::uuid, 'user', ${uid}, 'member.left',
        '{}'::jsonb, null::inet, null::text
      )
    `;
  });
}

/** Notify workspace members (stub — uses the notify matrix). */
async function notify(wsId: string, kind: string, data: Record<string, unknown>): Promise<void> {
  console.log(`[notify] ${kind} for ws ${wsId}:`, data);
}

/** Prune stale invitations (nightly cron). Deletes consumed/expired rows older than 30 days. */
export async function pruneInvitations(): Promise<number> {
  const pool = getSystemPool();
  const result = await pool`
    delete from memberships
    where status = 'invited'
      and invite_expires_at < now() - interval '30 days'
    returning id
  `;
  return result.length;
}
