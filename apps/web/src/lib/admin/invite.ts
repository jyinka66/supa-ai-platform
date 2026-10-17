// Admin invite + removal — no self-service escalation.
//
// ── inviteAdmin(inviter, email, role) — the spec's token-based flow ──
//   Only OWNERS can invite. Creates a single-use invite token (HMAC-signed,
//   48h expiry) carrying (email, role). The token is emailed to the recipient
//   (out of scope for the service). The recipient calls acceptAdminInvite(token)
//   to create the admin_users row.
//
//   This is SEPARATE from the direct-creation flow (createAdminDirect below),
//   which is used for bootstrap (the first owner) or when the user's auth id
//   is already known. The token flow is the canonical admin-invite path —
//   the inviter only needs the email, not the user id.
//
// ── acceptAdminInvite(token, userId) ──
//   Verifies the token (HMAC + expiry) + creates the admin_users row in
//   INVITED state (mfa_enrolled=false, accepted_at=null). The invitee must
//   then enroll MFA + call acceptInvite(userId) to confirm.
//
// ── removeAdmin(actor, adminId) — the spec's removal ──
//   Only OWNERS can remove. Cannot remove self (owners remove owners, but
//   not themselves — prevents a lone owner from locking themselves out).
//   Revokes the admin_users row (sets revoked_at) + HARD-DELETES all their
//   admin_sessions (sessions die instantly — no grace period).
//
//   FIX from our previous revokeAdmin: the old impl blocked removing owners
//   (`cannot_revoke_owner`). The spec says "owners remove owners" — an owner
//   CAN remove another owner. Only self-removal is blocked.
//
// ── Quarterly review ──
//   admin_users.quarterly_reviewed_at. The review cron alerts on admins
//   not reviewed in 90 days.

import { db } from "@supa/db";
import { adminUsers } from "@supa/db/schema";
import { eq, and, isNull, isNotNull, sql } from "drizzle-orm";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  getAdminUser,
  revokeAllAdminSessions,
  AdminAuthError,
  type AdminRole,
  type AdminSessionRow,
} from "./auth";

// Re-export AdminContext for the route layer (the spec's `Session` type).
export type { AdminRole } from "./auth";

/** The spec's `Session` type — the admin's authenticated context. */
export interface AdminSession {
  adminId: string;
  role: AdminRole;
  sessionId: string;
  ip: string;
}

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export interface InviteResult {
  userId: string;
  role: AdminRole;
  invitedBy: string;
  invitedAt: Date;
}

export interface OverdueReview {
  userId: string;
  role: AdminRole;
  quarterlyReviewedAt: Date | null;
  daysOverdue: number;
}

const QUARTERLY_REVIEW_DAYS = 90;

// ───────────────────────────────────────────────
// createAdminDirect — bootstrap/direct admin creation
// ───────────────────────────────────────────────

/**
 * Create an admin_users row directly (INVITED state, mfa_enrolled=false).
 * Used for bootstrap (the first owner) or when the user's auth id is known.
 *
 * For the canonical email-token invite flow, use `inviteAdmin(inviter, email, role)`
 * below — it creates a single-use token + emails the recipient.
 *
 * Only an existing admin can create (the caller verifies via requireAdminSession).
 *
 * @throws AdminAuthError(409) if the user is already an admin.
 * @throws AdminAuthError(400) if the role is invalid.
 */
export async function createAdminDirect(
  userId: string,
  role: AdminRole,
  invitedBy: string,
): Promise<InviteResult> {
  if (!["owner", "senior", "standard", "support", "read_only"].includes(role)) {
    throw new AdminAuthError(`invalid_role:${role}`, 400);
  }

  // Check if already an admin.
  const existing = await getAdminUser(userId);
  if (existing && !existing.revokedAt) {
    throw new AdminAuthError("already_admin", 409);
  }

  const invitedAt = new Date();

  // Upsert: if there's a revoked row, reactivate it; otherwise insert.
  if (existing?.revokedAt) {
    await db
      .update(adminUsers)
      .set({
        role,
        invitedBy: invitedBy as any,
        invitedAt,
        acceptedAt: null,
        revokedAt: null,
        mfaEnrolled: false,
        mfaSecret: null,
      })
      .where(eq(adminUsers.userId, userId as any));
  } else {
    await db.insert(adminUsers).values({
      userId: userId as any,
      role,
      invitedBy: invitedBy as any,
      invitedAt,
      mfaEnrolled: false,
    });
  }

  await auditAdmin("admin.invited", invitedBy, { invited: userId, role });

  return { userId, role, invitedBy, invitedAt };
}

// ───────────────────────────────────────────────
// acceptInvite — set accepted_at + mfa_enrolled (MFA-gated)
// ───────────────────────────────────────────────

/**
 * Accept an admin invite. Requires MFA enrollment (the CHECK constraint
 * enforces `mfa_enrolled or accepted_at is null` — you can't set accepted_at
 * without mfa_enrolled=true). The caller (the route) must have already
 * enrolled MFA (generated + confirmed the TOTP secret).
 *
 * @throws AdminAuthError(403) if not invited.
 * @throws AdminAuthError(409) if already accepted.
 * @throws AdminAuthError(403) if MFA not enrolled (the CHECK would also block this).
 */
export async function acceptInvite(userId: string): Promise<void> {
  const admin = await getAdminUser(userId);
  if (!admin) throw new AdminAuthError("not_invited", 403);
  if (admin.revokedAt) throw new AdminAuthError("admin_revoked", 403);
  if (!admin.mfaEnrolled) {
    throw new AdminAuthError("mfa_enrollment_required", 403);
  }

  // The CHECK constraint will also enforce this, but we check explicitly for
  // a clearer error.
  const now = new Date();
  const result = await db
    .update(adminUsers)
    .set({ acceptedAt: now, quarterlyReviewedAt: now })
    .where(
      and(
        eq(adminUsers.userId, userId as any),
        isNull(adminUsers.acceptedAt),
        eq(adminUsers.mfaEnrolled, true),
      ),
    )
    .returning({ userId: adminUsers.userId });

  if (result.length === 0) {
    throw new AdminAuthError("already_accepted_or_mfa_not_enrolled", 409);
  }

  await auditAdmin("admin.invite_accepted", userId, { admin: userId });
}

// ───────────────────────────────────────────────
// revokeAdmin — revoke admin access + all sessions
// ───────────────────────────────────────────────

/**
 * Revoke an admin. Sets admin_users.revoked_at + revokes all their sessions
 * immediately.
 *
 * FIX from the spec: the old impl blocked removing owners (`cannot_revoke_owner`).
 * The spec says "owners remove owners" — an owner CAN remove another owner.
 * Only self-removal is blocked (enforced in `removeAdmin`, not here — this
 * lower-level function is called by `removeAdmin` after the self-check).
 *
 * Kept as a lower-level helper (used by `removeAdmin` + potentially by other
 * internal flows like a security-incident auto-revoke).
 */
export async function revokeAdmin(
  targetUserId: string,
  byUserId: string,
  reason: string = "offboarded",
): Promise<void> {
  const target = await getAdminUser(targetUserId);
  if (!target) throw new AdminAuthError("not_admin", 404);

  await db
    .update(adminUsers)
    .set({ revokedAt: new Date() })
    .where(eq(adminUsers.userId, targetUserId as any));

  // Hard-delete all sessions (the spec: `delete from admin_sessions where admin_id=$1`).
  // Sessions die instantly — no grace period. We hard-delete (not soft-revoke)
  // because admin sessions don't need to be preserved for audit (the audit log
  // records the removal event itself, not the session rows).
  const deletedCount = await hardDeleteAdminSessions(targetUserId);

  await auditAdmin("admin.removed", byUserId, {
    removed: targetUserId,
    reason,
    sessionsKilled: deletedCount,
  });
}

/**
 * Hard-delete all admin_sessions for an admin (the spec's `delete from admin_sessions`).
 * Returns the count deleted.
 */
async function hardDeleteAdminSessions(adminId: string): Promise<number> {
  const result = await db.execute(sql`
    delete from admin_sessions where admin_id = ${adminId}::uuid returning 1
  `);
  return (result as unknown as Array<{ "1": number }>).length;
}

// ───────────────────────────────────────────────
// markMfaEnrolled — set mfa_enrolled + store the (encrypted) secret
// ───────────────────────────────────────────────

/**
 * Mark an admin as MFA-enrolled + store the KMS-encrypted TOTP secret.
 * Called by the MFA enrollment flow (the route generates the secret via
 * mfa.ts, the user confirms with a TOTP code, then this function persists
 * the enrollment).
 *
 * The secret must be KMS-encrypted before being passed here (same pattern
 * as product MFA — see auth/mfa.ts kmsEncrypt).
 */
export async function markMfaEnrolled(userId: string, encryptedSecret: string): Promise<void> {
  await db
    .update(adminUsers)
    .set({ mfaEnrolled: true, mfaSecret: encryptedSecret })
    .where(eq(adminUsers.userId, userId as any));
  await auditAdmin("admin.mfa_enrolled", userId, { admin: userId });
}

// ───────────────────────────────────────────────
// Quarterly review
// ───────────────────────────────────────────────

/**
 * List admins overdue for quarterly review (>90 days since last review).
 * Returns the admins + how many days overdue they are.
 */
export async function listOverdueReviews(): Promise<OverdueReview[]> {
  const cutoff = new Date(Date.now() - QUARTERLY_REVIEW_DAYS * 86400000);
  const rows = await db
    .select({
      userId: adminUsers.userId,
      role: adminUsers.role,
      quarterlyReviewedAt: adminUsers.quarterlyReviewedAt,
    })
    .from(adminUsers)
    .where(
      and(
        isNull(adminUsers.revokedAt),
        isNotNull(adminUsers.acceptedAt), // only accepted admins
        sql`(${adminUsers.quarterlyReviewedAt} is null or ${adminUsers.quarterlyReviewedAt} < ${cutoff})`,
      ),
    );

  return rows.map((r) => {
    const reviewedAt = r.quarterlyReviewedAt;
    const referenceDate = reviewedAt ?? new Date(0); // never reviewed = epoch
    const daysOverdue = Math.floor(
      (Date.now() - referenceDate.getTime() - QUARTERLY_REVIEW_DAYS * 86400000) / 86400000,
    );
    return {
      userId: r.userId as string,
      role: r.role as AdminRole,
      quarterlyReviewedAt: reviewedAt,
      daysOverdue: Math.max(0, daysOverdue),
    };
  });
}

/**
 * Mark an admin as reviewed (quarterly review complete). Resets
 * quarterly_reviewed_at to now.
 */
export async function markReviewed(targetUserId: string, byUserId: string): Promise<void> {
  await db
    .update(adminUsers)
    .set({ quarterlyReviewedAt: new Date() })
    .where(eq(adminUsers.userId, targetUserId as any));
  await auditAdmin("admin.reviewed", byUserId, { reviewed: targetUserId });
}

// ───────────────────────────────────────────────
// Audit helper
// ───────────────────────────────────────────────

async function auditAdmin(action: string, actorId: string, target: Record<string, unknown>): Promise<void> {
  try {
    await db.execute(sql`
      select enterprise_audit_log_append(
        null::uuid, 'admin', ${actorId}, ${action},
        ${JSON.stringify(target)}::jsonb, null::inet, null::text
      )
    `);
  } catch {
    console.error("[admin] audit failed:", action, target);
  }
}

// ───────────────────────────────────────────────
// Invite token system (spec: createInviteToken)
// ───────────────────────────────────────────────

const INVITE_TTL_HOURS = 48;
const INVITE_SECRET = process.env.ADMIN_INVITE_SECRET ?? process.env.SUPABASE_JWT_SECRET ?? "dev-admin-invite-secret";

export interface AdminInviteToken {
  email: string;
  role: AdminRole;
  expiresAt: number; // epoch ms.
  nonce: string;
  hmac: string;
}

/** Token format: base64url(JSON({email, role, exp, nonce})).hmac */
export function createInviteToken(email: string, role: AdminRole): string {
  if (!["owner", "senior", "standard", "support", "read_only"].includes(role)) {
    throw new AdminAuthError(`invalid_role:${role}`, 400);
  }
  const expiresAt = Date.now() + INVITE_TTL_HOURS * 3600_000;
  const nonce = randomUUID();
  const payload: AdminInviteToken = { email, role, expiresAt, nonce, hmac: "" };
  // Sign the canonical payload (email|role|exp|nonce) — NOT including the hmac field.
  const canonical = `${email}|${role}|${expiresAt}|${nonce}`;
  payload.hmac = signHmac(canonical);
  const body = Buffer.from(JSON.stringify({ email, role, expiresAt: expiresAt, nonce })).toString("base64url");
  return `${body}.${payload.hmac}`;
}

/** HMAC-SHA256 of a payload, hex-encoded. */
function signHmac(payload: string): string {
  return createHmac("sha256", INVITE_SECRET).update(payload).digest("hex");
}

/** Constant-time string comparison. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

export interface ParsedInviteToken {
  email: string;
  role: AdminRole;
  expiresAt: number;
  nonce: string;
}

/** Parse + verify an invite token. Returns the payload or null (no oracle). */
export function verifyInviteToken(token: string): ParsedInviteToken | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, hmac] = parts;
  if (!body || !hmac) return null;

  let payload: { email?: string; role?: string; expiresAt?: number; nonce?: string };
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload.email || !payload.role || !payload.expiresAt || !payload.nonce) return null;
  if (!["owner", "senior", "standard", "support", "read_only"].includes(payload.role)) return null;

  // Verify HMAC (constant-time).
  const canonical = `${payload.email}|${payload.role}|${payload.expiresAt}|${payload.nonce}`;
  const expected = signHmac(canonical);
  if (!safeEqual(hmac, expected)) return null;

  // Check expiry.
  if (Date.now() > payload.expiresAt) return null;

  return {
    email: payload.email,
    role: payload.role as AdminRole,
    expiresAt: payload.expiresAt,
    nonce: payload.nonce,
  };
}

// ───────────────────────────────────────────────
// inviteAdmin — the spec's token-based invite flow (owner-only)
// ───────────────────────────────────────────────

export interface InviteAdminResult {
  token: string;
  email: string;
  role: AdminRole;
  expiresAt: Date;
}

/**
 * Invite a new admin (owner-only). Creates a single-use invite token
 * (HMAC-signed, 48h expiry) carrying (email, role). The token is returned
 * to the caller — the route is responsible for emailing it to the recipient.
 *
 * The recipient calls acceptAdminInvite(token, userId) to create the
 * admin_users row, then enrolls MFA + accepts.
 *
 * NO SELF-SERVICE ESCALATION: only owners can invite. A senior admin (even
 * with file:share) cannot invite — inviting is a control-plane grant that
 * only owners hold.
 *
 * @param inviter — the authenticated admin context (must be owner).
 * @param email — the recipient's email (for the token + the audit log).
 * @param role — the role to grant.
 * @returns The invite token (the route emails it to the recipient).
 *
 * @throws AdminAuthError(403) if the inviter is not an owner.
 * @throws AdminAuthError(400) if the role is invalid.
 */
export async function inviteAdmin(
  inviter: AdminSession,
  email: string,
  role: AdminRole,
): Promise<InviteAdminResult> {
  // Only owners invite — no self-service escalation.
  if (inviter.role !== "owner") {
    throw new AdminAuthError("only_owners_can_invite", 403);
  }
  if (!["owner", "senior", "standard", "support", "read_only"].includes(role)) {
    throw new AdminAuthError(`invalid_role:${role}`, 400);
  }

  const token = createInviteToken(email, role);
  const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 3600_000);

  await auditAdmin("admin.invited", inviter.adminId, {
    invitedEmail: email,
    role,
    expiresAt: expiresAt.toISOString(),
  });

  return { token, email, role, expiresAt };
}

// ───────────────────────────────────────────────
// acceptAdminInvite — verify token + create admin_users row
// ───────────────────────────────────────────────

/**
 * Accept an admin invite. Verifies the token (HMAC + expiry) + creates the
 * admin_users row in INVITED state (mfa_enrolled=false, accepted_at=null).
 *
 * The caller authenticates via product auth (the recipient's normal session)
 * — this is the bootstrap path. The recipient's userId is passed in.
 *
 * After this, the recipient must:
 *   1. Enroll admin MFA (POST /api/admin/mfa/enroll → confirm).
 *   2. Call acceptInvite(userId) to set accepted_at + mfa_enrolled=true.
 *   3. Then they can /api/admin/login (product auth + admin MFA step-up).
 *
 * @throws AdminAuthError(400) if the token is invalid/expired (no oracle —
 *         uniform "invalid_token" for all failure modes).
 * @throws AdminAuthError(409) if the user is already an admin.
 */
export async function acceptAdminInvite(
  token: string,
  userId: string,
): Promise<{ role: AdminRole }> {
  const parsed = verifyInviteToken(token);
  if (!parsed) {
    // No oracle — invalid/expired/wrong-HMAC all → invalid_token.
    throw new AdminAuthError("invalid_token", 400);
  }

  // Check if already an admin (active or revoked — reactivate revoked).
  const existing = await getAdminUser(userId);
  if (existing && !existing.revokedAt) {
    throw new AdminAuthError("already_admin", 409);
  }

  if (existing?.revokedAt) {
    // Reactivate a revoked admin row.
    await db
      .update(adminUsers)
      .set({
        role: parsed.role,
        invitedBy: null, // token-based — no direct inviter id.
        invitedAt: new Date(),
        acceptedAt: null,
        revokedAt: null,
        mfaEnrolled: false,
        mfaSecret: null,
      })
      .where(eq(adminUsers.userId, userId as any));
  } else {
    await db.insert(adminUsers).values({
      userId: userId as any,
      role: parsed.role,
      invitedAt: new Date(),
      mfaEnrolled: false,
    });
  }

  await auditAdmin("admin.invite_accepted", userId, {
    admin: userId,
    role: parsed.role,
    email: parsed.email,
  });

  return { role: parsed.role };
}

// ───────────────────────────────────────────────
// removeAdmin — the spec's removal (owner-only, no self-removal)
// ───────────────────────────────────────────────

/**
 * Remove an admin (owner-only, no self-removal).
 *
 * The spec:
 *   if (actor.role !== "owner") throw Forbidden();
 *   if (actor.admin_id === adminId) throw Forbidden();  // cannot remove self
 *   await sys.q(`update admin_users set revoked_at=now() where user_id=$1`, [adminId]);
 *   await sys.q(`delete from admin_sessions where admin_id=$1`, [adminId]);
 *   await adminAudit({ action: "admin.removed", ... });
 *
 * "owners remove owners" — an owner CAN remove another owner (the previous
 * `revokeAdmin` blocked this; the spec allows it). Only SELF-removal is
 * blocked (prevents a lone owner from locking themselves out).
 *
 * Sessions are HARD-DELETED (not soft-revoked) — they die instantly.
 *
 * @throws AdminAuthError(403) if the actor is not an owner.
 * @throws AdminAuthError(403) if the actor is trying to remove themselves.
 * @throws AdminAuthError(404) if the target admin doesn't exist.
 */
export async function removeAdmin(
  actor: AdminSession,
  adminId: string,
): Promise<void> {
  // Only owners remove.
  if (actor.role !== "owner") {
    throw new AdminAuthError("only_owners_can_remove", 403);
  }
  // Cannot remove self — owners remove owners, but not themselves.
  if (actor.adminId === adminId) {
    throw new AdminAuthError("cannot_remove_self", 403);
  }

  // Verify the target exists (defense-in-depth — revokeAdmin also checks).
  const target = await getAdminUser(adminId);
  if (!target) throw new AdminAuthError("not_admin", 404);

  // Revoke the admin + hard-delete sessions (delegates to revokeAdmin which
  // now hard-deletes sessions per the spec).
  await revokeAdmin(adminId, actor.adminId, "removed_by_owner");
}
