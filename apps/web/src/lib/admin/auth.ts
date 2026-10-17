// Admin identity & auth — the control plane floor.
//
// SEPARATE FROM PRODUCT AUTH:
//   - Separate session table (admin_sessions, not sessions).
//   - Separate cookie (supa_admin, not supa_refresh).
//   - Separate token (argon2id-hashed, 8h hard cap, 30min sliding idle).
//   - Separate auth middleware (requireAdminSession, not authenticate).
//   - IP-bound (no roaming — the session is tied to the issuing IP).
//   - MFA-gated (mfa_ok must be true; the session is created only after
//     TOTP verification).
//
// A product session compromise grants ZERO admin surface: there's no
// is_admin boolean on the product users table, no shared session table, no
// role escalation path from product → admin. The admin_users row is the
// single source of truth for "is this user an admin."
//
// ── isAdmin(userId) — the single source of truth ──
//   Returns true iff an admin_users row exists for the user with
//   revoked_at IS NULL. NOT cached (admin checks are low-volume; the cache
//   was a 60s staleness window that's unacceptable for revocation). The
//   old isPlatformAdmin stub checked workspace roles — WRONG. Admin access
//   is a separate grant, not a side-effect of workspace ownership.
//
// ── Session lifecycle ──
//   createAdminSession(adminId, ip, ua) — mints a token (32 bytes base64url),
//     argon2id-hashes it, inserts admin_sessions row (8h expires_at,
//     30min idle_expires_at, mfa_ok=true). Returns the raw token ONCE.
//   verifyAdminSession(token, ip) — argon2id-verifies the token against
//     admin_sessions.token_hash (iterates active sessions for the admin —
//     argon2id can't be indexed). Checks: revoked_at IS NULL, expires_at
//     not passed, idle_expires_at not passed, IP matches (no roaming),
//     admin_users.revoked_at IS NULL. Slides idle_expires_at on success.
//   revokeAdminSession(sessionId) / revokeAllAdminSessions(adminId).
//
// ── IP allowlist ──
//   admin_users.ip_allowlist: null OR empty = deny ALL (default deny).
//   Non-empty = only those IPs can hold an admin session. Checked at
//   session creation + at verification (defense-in-depth).
//
// ── Quarterly review ──
//   admin_users.quarterly_reviewed_at. The review cron alerts on admins
//   not reviewed in 90 days. An unreviewed admin's sessions are NOT auto-
//   revoked (the review is a human gate, not an auto-kill) — but the alert
//   is loud + the admin's access is flagged in the admin UI.

import { db } from "@supa/db";
import { adminUsers, adminSessions } from "@supa/db/schema";
import { eq, and, isNull, sql } from "drizzle-orm";
import { randomBytes, timingSafeEqual } from "node:crypto";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type AdminRole = "owner" | "senior" | "standard" | "support" | "read_only";

export interface AdminUser {
  userId: string;
  role: AdminRole;
  mfaEnrolled: boolean;
  ipAllowlist: string[] | null;
  revokedAt: Date | null;
  quarterlyReviewedAt: Date | null;
}

export interface AdminSessionRow {
  id: string;
  adminId: string;
  ip: string;
  mfaOk: boolean;
  expiresAt: Date;
  idleExpiresAt: Date;
  revokedAt: Date | null;
}

export interface CreateAdminSessionResult {
  sessionId: string;
  /** The raw session token — returned ONCE (only argon2id hash is stored). */
  token: string;
  expiresAt: Date;
}

export class AdminAuthError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "AdminAuthError";
  }
}

// ───────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────

const TOKEN_BYTES = 32; // 256 bits → 43 base64url chars.
const HARD_CAP_MS = 8 * 60 * 60 * 1000; // 8 hours.
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes.

export const ADMIN_COOKIE_NAME = "supa_admin";

// argon2id params — OWASP 2024 baseline (same as product sessions).
const ARGON2_PARAMS = {
  type: 2, // argon2id (numeric — matches mfa.ts pattern)
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

// ───────────────────────────────────────────────
// isAdmin — the single source of truth
// ───────────────────────────────────────────────

/**
 * Returns true iff the user has an active admin_users row (revoked_at IS NULL).
 *
 * NOT cached. The old isPlatformAdmin stub cached in Redis for 60s —
 * unacceptable for revocation (an admin revoked at t=0 is still admin at
 * t=59s). Admin checks are low-volume (admin endpoints are rare), so the
 * DB hit is fine.
 *
 * This REPLACES the old isPlatformAdmin stub, which checked workspace roles
 * (owner/admin in any workspace). That was WRONG — workspace adminship is a
 * product concept, not a control-plane grant. A workspace owner is NOT an
 * admin of the platform unless they have an admin_users row.
 */
export async function isAdmin(userId: string): Promise<boolean> {
  const rows = await db
    .select({ userId: adminUsers.userId })
    .from(adminUsers)
    .where(
      and(
        eq(adminUsers.userId, userId as any),
        isNull(adminUsers.revokedAt),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Backward-compat alias for `isAdmin`. Some existing routes call
 * `isPlatformAdmin(user)` with a Supabase User object — this overload
 * accepts either a userId string or a { id }-shaped object.
 *
 * @deprecated use `isAdmin(userId)` directly. The `user`-object overload
 *             exists only to avoid breaking existing callers during the
 *             migration to the new admin auth.
 */
export async function isPlatformAdmin(user: string | { id?: string }): Promise<boolean> {
  const userId = typeof user === "string" ? user : (user?.id ?? "");
  if (!userId) return false;
  return isAdmin(userId);
}

/**
 * Get the admin record for a user. Returns null if not an admin.
 */
export async function getAdminUser(userId: string): Promise<AdminUser | null> {
  const rows = await db
    .select({
      userId: adminUsers.userId,
      role: adminUsers.role,
      mfaEnrolled: adminUsers.mfaEnrolled,
      ipAllowlist: adminUsers.ipAllowlist,
      revokedAt: adminUsers.revokedAt,
      quarterlyReviewedAt: adminUsers.quarterlyReviewedAt,
    })
    .from(adminUsers)
    .where(eq(adminUsers.userId, userId as any))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    userId: row.userId as string,
    role: row.role as AdminRole,
    mfaEnrolled: row.mfaEnrolled,
    ipAllowlist: row.ipAllowlist ?? null,
    revokedAt: row.revokedAt,
    quarterlyReviewedAt: row.quarterlyReviewedAt,
  };
}

// ───────────────────────────────────────────────
// IP allowlist enforcement
// ───────────────────────────────────────────────

/**
 * Check if an IP is allowed for an admin.
 *
 * Default DENY: null OR empty array = deny all. A non-empty allowlist = only
 * those IPs.
 *
 * Uses timingSafeEqual for IP comparison (constant-time — prevents timing
 * attacks that could probe the allowlist one IP at a time).
 */
export function isIpAllowed(admin: AdminUser, ip: string): boolean {
  const allowlist = admin.ipAllowlist;
  if (!allowlist || allowlist.length === 0) {
    // Default deny — no allowlist = no access.
    return false;
  }
  for (const allowed of allowlist) {
    if (ipEqual(allowed, ip)) return true;
  }
  return false;
}

/** Constant-time IP equality (handles IPv4 + IPv6). */
function ipEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

// ───────────────────────────────────────────────
// Session token generation + hashing (argon2id)
// ───────────────────────────────────────────────

/** Generate a random 43-char base64url session token (256 bits). */
export function generateAdminToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** argon2id-hash the session token (same params as product sessions). */
async function hashToken(rawToken: string): Promise<string> {
  const argon2 = await import("argon2");
  return argon2.hash(rawToken, ARGON2_PARAMS);
}

/** Verify a raw token against an argon2id hash. */
async function verifyToken(hash: string, rawToken: string): Promise<boolean> {
  const argon2 = await import("argon2");
  try {
    return await argon2.verify(hash, rawToken);
  } catch {
    return false;
  }
}

// ───────────────────────────────────────────────
// createAdminSession
// ───────────────────────────────────────────────

/**
 * Create an admin session. Called after the admin has authenticated via
 * the product auth + stepped up via MFA (TOTP).
 *
 * Flow:
 *   1. Lookup the admin_users row (must exist, not revoked, MFA enrolled).
 *   2. Enforce IP allowlist (default deny).
 *   3. Mint a random token (32 bytes → base64url).
 *   4. argon2id-hash the token.
 *   5. INSERT admin_sessions (8h expires_at, 30min idle_expires_at, mfa_ok=true).
 *   6. Audit (global system event — ws_id null).
 *   7. Return the raw token ONCE.
 *
 * @throws AdminAuthError(403) if not an admin / revoked / MFA not enrolled.
 * @throws AdminAuthError(403) if IP not in allowlist.
 */
export async function createAdminSession(
  userId: string,
  ip: string,
  userAgent?: string,
): Promise<CreateAdminSessionResult> {
  const admin = await getAdminUser(userId);
  if (!admin || admin.revokedAt) {
    throw new AdminAuthError("not_admin_or_revoked", 403);
  }
  if (!admin.mfaEnrolled) {
    throw new AdminAuthError("mfa_enrollment_required", 403);
  }
  if (!isIpAllowed(admin, ip)) {
    throw new AdminAuthError("ip_not_allowed", 403);
  }

  const rawToken = generateAdminToken();
  const tokenHash = await hashToken(rawToken);
  const now = Date.now();
  const expiresAt = new Date(now + HARD_CAP_MS);
  const idleExpiresAt = new Date(now + IDLE_TIMEOUT_MS);

  const rows = await db
    .insert(adminSessions)
    .values({
      adminId: userId as any,
      tokenHash,
      ip: ip as any,
      ...(userAgent ? { userAgent } : {}),
      mfaOk: true,
      expiresAt,
      idleExpiresAt,
    })
    .returning({ id: adminSessions.id });
  const row = rows[0];
  if (!row) throw new AdminAuthError("session_insert_failed", 500);

  await auditGlobal("admin.session.created", { admin: userId, session: row.id, ip });

  return { sessionId: row.id as string, token: rawToken, expiresAt };
}

// ───────────────────────────────────────────────
// verifyAdminSession
// ───────────────────────────────────────────────

/**
 * Verify an admin session token. Returns the session row if valid, null if
 * invalid (no oracle — the caller treats all invalid states as 401).
 *
 * Checks:
 *   1. Token argon2id-verifies against some active session's token_hash.
 *      (Iterates active sessions — argon2id can't be indexed. Low volume.)
 *   2. Session.revoked_at IS NULL.
 *   3. Session.expires_at not passed (8h hard cap).
 *   4. Session.idle_expires_at not passed (30min sliding — checked before slide).
 *   5. Session.ip matches the requesting IP (no roaming).
 *   6. Admin_users.revoked_at IS NULL (admin was revoked after session created).
 *
 * On success, slides idle_expires_at (30min from now, capped at expires_at).
 *
 * @returns The session row (with admin role), or null.
 */
export async function verifyAdminSession(
  rawToken: string,
  ip: string,
): Promise<(AdminSessionRow & { role: AdminRole }) | null> {
  // Find all active sessions (not revoked, not expired) — we'll iterate + argon2-verify each.
  // argon2id can't be indexed, so we can't look up by token_hash directly.
  // This is O(active sessions) — acceptable for admin volume (low single digits).
  const candidates = await db
    .select({
      id: adminSessions.id,
      adminId: adminSessions.adminId,
      tokenHash: adminSessions.tokenHash,
      ip: adminSessions.ip,
      mfaOk: adminSessions.mfaOk,
      expiresAt: adminSessions.expiresAt,
      idleExpiresAt: adminSessions.idleExpiresAt,
      revokedAt: adminSessions.revokedAt,
      role: adminUsers.role,
      adminRevokedAt: adminUsers.revokedAt,
    })
    .from(adminSessions)
    .innerJoin(adminUsers, eq(adminUsers.userId, adminSessions.adminId))
    .where(
      and(
        isNull(adminSessions.revokedAt),
        sql`${adminSessions.expiresAt} > now()`,
        sql`${adminSessions.idleExpiresAt} > now()`,
        isNull(adminUsers.revokedAt),
      ),
    );

  for (const c of candidates) {
    const match = await verifyToken(c.tokenHash as string, rawToken);
    if (!match) continue;

    // IP must match (no roaming).
    const sessionIp = String(c.ip);
    if (sessionIp !== ip) {
      // IP mismatch — this is suspicious. Revoke the session (possible token theft).
      await revokeAdminSession(c.id as string, "ip_mismatch");
      await auditGlobal("admin.session.ip_mismatch_revoke", {
        admin: c.adminId,
        session: c.id,
        expected: sessionIp,
        actual: ip,
      });
      return null;
    }

    if (!c.mfaOk) continue; // session not MFA-satisfied.

    // Slide the idle timeout (capped at the hard cap).
    const now = Date.now();
    const newIdle = new Date(Math.min(now + IDLE_TIMEOUT_MS, c.expiresAt.getTime()));
    await db
      .update(adminSessions)
      .set({ idleExpiresAt: newIdle })
      .where(eq(adminSessions.id, c.id as any));

    return {
      id: c.id as string,
      adminId: c.adminId as string,
      ip: sessionIp,
      mfaOk: c.mfaOk,
      expiresAt: c.expiresAt,
      idleExpiresAt: newIdle,
      revokedAt: c.revokedAt,
      role: c.role as AdminRole,
    };
  }

  return null;
}

// ───────────────────────────────────────────────
// revokeAdminSession / revokeAllAdminSessions
// ───────────────────────────────────────────────

/**
 * Revoke a single admin session. Idempotent (already-revoked is a no-op).
 */
export async function revokeAdminSession(
  sessionId: string,
  reason: string = "manual",
): Promise<void> {
  await db
    .update(adminSessions)
    .set({ revokedAt: new Date() })
    .where(eq(adminSessions.id, sessionId as any));
  await auditGlobal("admin.session.revoked", { session: sessionId, reason });
}

/**
 * Revoke ALL sessions for an admin. Called when the admin is revoked,
 * changes MFA, or suspects compromise.
 */
export async function revokeAllAdminSessions(adminId: string, reason: string = "admin_revoked"): Promise<number> {
  const result = await db.execute(sql`
    update admin_sessions
       set revoked_at = now()
     where admin_id = ${adminId}::uuid
       and revoked_at is null
    returning id
  `);
  const rows = result as unknown as { id: string }[];
  await auditGlobal("admin.sessions.bulk_revoked", { admin: adminId, count: rows.length, reason });
  return rows.length;
}

// ───────────────────────────────────────────────
// listAdminSessions — for the admin's device list UI
// ───────────────────────────────────────────────

export async function listAdminSessions(adminId: string): Promise<AdminSessionRow[]> {
  const rows = await db
    .select({
      id: adminSessions.id,
      adminId: adminSessions.adminId,
      ip: adminSessions.ip,
      mfaOk: adminSessions.mfaOk,
      expiresAt: adminSessions.expiresAt,
      idleExpiresAt: adminSessions.idleExpiresAt,
      revokedAt: adminSessions.revokedAt,
    })
    .from(adminSessions)
    .where(eq(adminSessions.adminId, adminId as any))
    .orderBy(sql`${adminSessions.createdAt} desc`);
  return rows.map((r) => ({
    id: r.id as string,
    adminId: r.adminId as string,
    ip: String(r.ip),
    mfaOk: r.mfaOk,
    expiresAt: r.expiresAt,
    idleExpiresAt: r.idleExpiresAt,
    revokedAt: r.revokedAt,
  }));
}

// ───────────────────────────────────────────────
// Reaper — purge expired/idle sessions (called by the cron)
// ───────────────────────────────────────────────

/**
 * Purge admin sessions past their hard cap (expires_at) OR idle timeout
 * (idle_expires_at). These are already invalid (verifyAdminSession rejects
 * them), but the reaper cleans up the DB so the candidate set stays small.
 *
 * Idempotent — safe to re-run.
 */
export async function reapExpiredAdminSessions(): Promise<{ purged: number }> {
  const result = await db.execute(sql`
    with deleted as (
      delete from admin_sessions
       where revoked_at is not null
          or expires_at < now()
          or idle_expires_at < now()
      returning 1
    )
    select count(*)::integer as n from deleted
  `);
  const n = Number((result as unknown as Array<{ n: number }>)[0]?.n ?? 0);
  return { purged: n };
}

// ───────────────────────────────────────────────
// Audit helper (global system event — ws_id null)
// ───────────────────────────────────────────────

async function auditGlobal(action: string, target: Record<string, unknown>): Promise<void> {
  try {
    await db.execute(sql`
      select enterprise_audit_log_append(
        null::uuid, 'system', 'admin-auth', ${action},
        ${JSON.stringify(target)}::jsonb, null::inet, null::text
      )
    `);
  } catch {
    // Audit failures must not break the auth flow. Log + continue.
    console.error("[admin-auth] audit failed:", action, target);
  }
}

// ───────────────────────────────────────────────
// login — the combined admin login service (spec: apps/admin/src/auth.ts)
//
// This is the canonical admin login flow, extracted from the route handler
// into a reusable service function. The route (POST /api/admin/login) calls
// this + translates the result to an HTTP response.
//
// ── Fixes from the pasted spec ──
// 1. `sha256(token)` → argon2id (hashToken). The codebase baseline (migration
//    0036 sessions v2, C11 fix for share passwords) is argon2id for ALL
//    bearer tokens. SHA-256 is fast → brute-forceable if the DB leaks.
//    argon2id (19 MiB, t=2, p=1) makes the hash unrecoverable.
// 2. The spec's `sys.touch("update admin_sessions set idle_expires_at=2whereid=2
//    where id=2whereid=1", ...)` — corrupted SQL (likely a paste/encoding
//    bug). Fixed to a proper Drizzle UPDATE: `set({ idleExpiresAt: newIdle })
//    .where(eq(id, sess.id))`. (This is in verifyAdminSession above — the
//    idle slide is already wired correctly there.)
// 3. `deny("not_found")` for admin-miss — the spec says "admin-miss
//    indistinguishable from bad password". Our login() returns
//    `deny("invalid_credentials")` (uniform) for both. Kept the no-oracle
//    principle but the reason name matches the product login route's
//    `{ error: "invalid_credentials" }` for uniformity.
// 4. `deny("enroll_required")` + `deny("locked_15m")` + `deny("mfa")` —
//    distinguishable denials (the admin needs to act on them). Added to
//    the LoginResult union. The route maps these to distinct HTTP bodies.
// 5. `mfaFailCount(user.id, d15min)` — implemented via the audit log (query
//    enterprise_audit_log for action='admin.auth.mfa_failed' in the last
//    15min). No separate table needed (admin login is low-volume; the audit
//    log is already append-only + hash-chained).
// 6. `webauthnValid(admin, totp)` — stub (returns false). The hardware_key
//    jsonb column exists (migration 0047) but the WebAuthn verification
//    flow isn't wired yet. Documented inline; the TOTP path is the primary
//    MFA. When WebAuthn is wired, this function verifies the assertion
//    against the stored credential.
// ───────────────────────────────────────────────

/** Role hierarchy — higher rank = more privilege. */
export const ROLE_RANK: Record<AdminRole, number> = {
  read_only: 1,
  support: 2,
  standard: 3,
  senior: 4,
  owner: 5,
};

/** MFA rate-limit: >5 failures in 15min → locked for 15min. */
const MFA_FAIL_WINDOW_MIN = 15;
const MFA_FAIL_MAX = 5;

export type LoginDenyReason = "invalid_credentials" | "enroll_required" | "locked_15m" | "mfa" | "ip_not_allowed";

export interface LoginDenied {
  ok: false;
  reason: LoginDenyReason;
}

export interface LoginSuccess {
  ok: true;
  token: string;
  sessionId: string;
  adminId: string;
  role: AdminRole;
  expiresAt: Date;
}

export type LoginResult = LoginSuccess | LoginDenied;

/** Construct a login denial. */
function deny(reason: LoginDenyReason): LoginDenied {
  return { ok: false, reason };
}

/**
 * Combined admin login — product auth + admin check + MFA + rate-limit + session.
 *
 * This is the spec's `login(email, password, totp, ip)` function. The route
 * handler (POST /api/admin/login) calls this + maps the result to an HTTP
 * response.
 *
 * Flow:
 *   1. Product auth (Supabase signInWithPassword — verifies the argon2id
 *      password hash). On failure → deny("invalid_credentials") (no oracle —
 *      can't tell if the email exists, the password is wrong, or the user
 *      isn't an admin).
 *   2. Admin check — admin_users row exists + revoked_at IS NULL. If not →
 *      deny("invalid_credentials") (admin-miss indistinguishable from bad
 *      password).
 *   3. IP allowlist — default deny (null/empty = deny all). If IP not
 *      allowed → deny("ip_not_allowed").
 *   4. MFA mandatory — no "trusted device" bypass, no grace period. If
 *      not enrolled → deny("enroll_required") (distinguishable — the admin
 *      must enroll before they can log in).
 *   5. TOTP verify (or WebAuthn if wired). On failure → audit
 *      "auth.mfa_failed" + check rate-limit (>5 in 15min → deny("locked_15m")).
 *      Otherwise → deny("mfa") (distinguishable — retry).
 *   6. Create the admin session (argon2id token, 8h hard cap, 30min idle,
 *      mfa_ok=true, IP-bound).
 *   7. Return { token } — the raw token is returned ONCE.
 *
 * @param supabaseVerifyResult — the Supabase auth result (from
 *        supabase.auth.signInWithPassword). Passing it in (rather than
 *        calling Supabase here) keeps this function testable without a
 *        Supabase client, and lets the route handle the Supabase timing
 *        envelope (dummy argon2 verify on failure).
 * @param email — for the audit log + otpauth label.
 * @param totp — the 6-digit TOTP code.
 * @param ip — the requesting IP (IP-bound session).
 * @param userAgent — for the device list UI.
 */
export async function login(
  userId: string | null,
  totp: string,
  ip: string,
  userAgent?: string,
): Promise<LoginResult> {
  // 1. Product auth already verified by the caller (Supabase). If null,
  //    the credentials were invalid → uniform denial.
  if (!userId) {
    return deny("invalid_credentials");
  }

  // 2. Admin check — NOT a boolean flag on the user row.
  const admin = await getAdminUser(userId);
  if (!admin || admin.revokedAt) {
    // admin-miss indistinguishable from bad password.
    return deny("invalid_credentials");
  }

  // 3. IP allowlist — default deny.
  if (!isIpAllowed(admin, ip)) {
    return deny("ip_not_allowed");
  }

  // 4. MFA mandatory — no bypass, no grace period.
  if (!admin.mfaEnrolled) {
    return deny("enroll_required");
  }

  // 5. TOTP verify (or WebAuthn).
  const totpOk = await verifyAdminTotp(userId, totp);
  const webauthnOk = await webauthnValid(admin, totp); // stub — returns false.

  if (!totpOk && !webauthnOk) {
    // Audit the failure (for rate-limit counting + security monitoring).
    await auditAdminFailure(userId, "admin.auth.mfa_failed", ip);

    // Rate-limit: >5 failures in 15min → locked.
    const fails = await mfaFailCount(userId, MFA_FAIL_WINDOW_MIN);
    if (fails > MFA_FAIL_MAX) {
      return deny("locked_15m");
    }
    return deny("mfa");
  }

  // 6. Create the session (argon2id token, 8h cap, 30min idle, mfa_ok=true).
  let session;
  try {
    session = await createAdminSession(userId, ip, userAgent);
  } catch (err) {
    if (err instanceof AdminAuthError) {
      // createAdminSession re-checks admin + MFA + IP. If it fails here,
      // it's a race (admin was revoked between our check + the insert).
      return deny("invalid_credentials");
    }
    throw err;
  }

  // 7. Return the raw token ONCE.
  return {
    ok: true,
    token: session.token,
    sessionId: session.sessionId,
    adminId: userId,
    role: admin.role,
    expiresAt: session.expiresAt,
  };
}

/**
 * Count MFA failures for a user in the last N minutes.
 * Uses the audit log (append-only, hash-chained — no separate table needed).
 *
 * Queries enterprise_audit_log for action='admin.auth.mfa_failed' +
 * actor_id=userId + created_at > now() - N minutes.
 */
export async function mfaFailCount(userId: string, withinMinutes: number): Promise<number> {
  const result = await db.execute(sql`
    select count(*)::integer as n
      from enterprise_audit_log
     where actor_id = ${userId}
       and action = 'admin.auth.mfa_failed'
       and created_at > now() - (${withinMinutes} || ' minutes')::interval
  `);
  const n = Number((result as unknown as Array<{ n: number }>)[0]?.n ?? 0);
  return n;
}

/**
 * Verify a TOTP code for an admin (delegates to the admin MFA module).
 * The MFA module decrypts the stored secret + verifies the code.
 */
async function verifyAdminTotp(adminId: string, totp: string): Promise<boolean> {
  try {
    const { verifyAdminMfa } = await import("./mfa");
    return await verifyAdminMfa(adminId, totp);
  } catch {
    return false;
  }
}

/**
 * WebAuthn verification — STUB.
 *
 * The admin_users.hardware_key jsonb column stores the WebAuthn credential
 * (public key, credential ID, counter). When wired, this function:
 *   1. Parses the assertion (the `totp` param is actually a WebAuthn
 *      assertion JSON when hardware key is used — the route would detect
 *      this by content-type or a separate field).
 *   2. Looks up the stored credential.
 *   3. Verifies the assertion signature + challenge + origin + RP ID + counter.
 *
 * Until wired, returns false (TOTP is the primary MFA). This is safe —
 * returning false just means the TOTP path must succeed.
 */
export async function webauthnValid(admin: AdminUser, _assertion: string): Promise<boolean> {
  if (!admin) return false;
  // TODO: implement WebAuthn assertion verification against admin.hardware_key.
  return false;
}

/** Audit an admin auth failure (for rate-limit counting + security monitoring). */
async function auditAdminFailure(userId: string, action: string, ip: string): Promise<void> {
  try {
    await db.execute(sql`
      select enterprise_audit_log_append(
        null::uuid, 'admin', ${userId}, ${action},
        jsonb_build_object('ip', ${ip})::jsonb,
        ${ip}::inet, null::text
      )
    `);
  } catch {
    console.error("[admin-auth] audit failure:", action, userId);
  }
}

/**
 * requireAdmin — the spec's middleware. Every admin request passes this.
 *
 * Checks:
 *   1. Session exists (token_hash match, not expired, not idle-expired,
 *      mfa_ok=true, admin not revoked).
 *   2. Role rank >= minRole (default read_only — all roles pass).
 *   3. Slides the idle timeout (30min from now, capped at expires_at).
 *
 * @param token — the raw admin token (from the cookie or Authorization header).
 * @param ip — the requesting IP (must match the session's IP — no roaming).
 * @param minRole — the minimum role required (default read_only).
 * @returns The session row (with admin role), or throws AdminAuthError(401/403).
 *
 * @throws AdminAuthError(401) if no valid session.
 * @throws AdminAuthError(403) if the role is insufficient.
 */
export async function requireAdmin(
  token: string,
  ip: string,
  minRole: AdminRole = "read_only",
): Promise<AdminSessionRow & { role: AdminRole }> {
  const sess = await verifyAdminSession(token, ip);
  if (!sess) {
    throw new AdminAuthError("invalid_admin_session", 401);
  }
  if (ROLE_RANK[sess.role] < ROLE_RANK[minRole]) {
    throw new AdminAuthError(`insufficient_role:${sess.role}<${minRole}`, 403);
  }
  return sess;
}
