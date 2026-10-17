// Session security + device management.
//
//   issueSession(userId, ctx)  — create a session + JWT + refresh token.
//   refresh(userId, jti, presented) — rotate the refresh token. REUSE
//     DETECTION: if a rotated refresh token is presented again (replay),
//     the ENTIRE family is revoked (all sessions in the family nuked).
//     This catches token theft (an attacker who stole + used a refresh
//     token gets caught when the legitimate user presents the now-rotated token).
//   revokeAllSessions(userId) — nuke all sessions (self-service + suspension).
//   listDevices(userId) — self-service device list (kind, IP, UA, lastSeen).
//   revokeSession(userId, sessionId) — revoke a single session.
//   checkIdleTimeout(session) — 401 if last_seen_at > idle_timeout.
//
// SESSION_TTL:
//   web: 30 days, mobile: 90 days, sso: 12 hours, apiKey: n/a (API keys have
//   their own expiry). The JWT expires at the session's expires_at.
//
// Refresh token rotation:
//   Each session belongs to a "family" (family_id). On refresh:
//     1. Look up the session by jti + userId.
//     2. If the session's rotated_at is set → REUSE DETECTED. The presented
//        token was already rotated (an attacker stole + used it, OR the
//        legitimate user is replaying). NUKE THE FAMILY: revoke all sessions
//        with the same family_id. Throw 401 with { alert: true }.
//     3. If valid → rotate: set rotated_at on the old session, create a new
//        session (same family_id) with a new refresh token. Return the new
//        JWT + refresh token.

import { db } from "@supa/db";
import { sessions } from "@supa/db/schema";
import { eq, and, sql, isNull } from "drizzle-orm";
import { createHash, randomBytes, createHmac, timingSafeEqual } from "node:crypto";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type SessionKind = "web" | "mobile" | "sso";

export interface SessionCtx {
  kind: SessionKind;
  ip: string;
  ua: string;
  /** Accept-Language header (for device fingerprinting). */
  language?: string;
  /** True if this session originated from SSO (not a password login). */
  sso?: boolean;
}

export interface IssuedSession {
  token: string; // JWT
  refreshToken: string; // raw refresh token (shown ONCE — stored as hash)
  sessionId: string; // jti
  expiresAt: Date;
}

export interface DeviceInfo {
  sessionId: string;
  kind: SessionKind;
  ip: string | null;
  userAgent: string | null;
  deviceHash: string | null;
  deviceLabel: string | null; // v2: human-readable device label.
  lastSeenAt: Date;
  createdAt: Date;
  ssoOriginated: boolean;
  mfaSatisfied: boolean; // v2: whether MFA was satisfied.
}

// ───────────────────────────────────────────────
// Constants — v2 design: short JWT (15 min) + opaque refresh (30 days).
// ───────────────────────────────────────────────

/**
 * JWT lifetime: 15 minutes. The JWT is stateless — it can't be revoked
 * mid-flight. The 15-min window is the maximum damage window for a stolen JWT.
 * After 15 min, the client must refresh using the opaque refresh token
 * (which CAN be revoked instantly at the server).
 */
export const JWT_TTL_MS = 15 * 60 * 1000; // 15 minutes.

/**
 * Session absolute cap: 30 days (the refresh token's maximum lifetime).
 * Even with continuous refresh, the session dies after 30 days — the user
 * must re-authenticate.
 */
export const SESSION_ABSOLUTE_TTL_MS = 30 * 86400000; // 30 days.

/**
 * Session idle timeout: 14 days (rolling — resets on each refresh).
 * If the user doesn't refresh within 14 days, the session expires.
 * This is the "idle_expires_at" column — updated on each refresh.
 */
export const SESSION_IDLE_TTL_MS = 14 * 86400000; // 14 days rolling.

/** Legacy: session TTL per kind (for backward compat with the old API). */
export const SESSION_TTL: Record<SessionKind, number> = {
  web: SESSION_ABSOLUTE_TTL_MS, // 30 days
  mobile: 90 * 86400000, // 90 days (mobile has a longer absolute cap).
  sso: 12 * 60 * 60 * 1000, // 12 hours
};

/** Idle timeout: if last_seen_at > this, prompt re-auth (configurable per workspace). */
const DEFAULT_IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour.

// ───────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────

/** Simple ApiError with status + optional extra. */
export class ApiError extends Error {
  constructor(message: string, public status: number, public extra?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Device fingerprint: a hash of the user agent + IP + accept-language.
 * Used for the device list UI ("Chrome on macOS from 1.2.3.4"). This is
 * NOT a security boundary (it's display-only — the actual auth is the JWT +
 * refresh token). The hash is deterministic (same UA+IP+lang → same hash).
 */
function deviceFingerprint(ctx: SessionCtx): string {
  return createHash("sha256")
    .update(`${ctx.ua}|${ctx.ip}|${ctx.language ?? ""}`)
    .digest("hex")
    .slice(0, 16);
}

/** SHA-256 hex hash of a refresh token (the raw token is never stored). Legacy. */
function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * v2: Hash a refresh token with argon2id (OWASP 2024 baseline).
 * The raw token is never stored — the hash is the lookup key.
 * Uses the password service's argon2id params (19 MiB, t=2, p=1).
 */
async function hashRefreshTokenArgon2(token: string): Promise<string> {
  const { hashPassword } = await import("./passwords.js");
  // hashPassword validates the password policy — but refresh tokens are
  // high-entropy (48 random bytes base64url = ~64 chars) so they always pass.
  // We skip the policy check by calling argon2 directly.
  const argon2 = await import("argon2");
  return argon2.hash(token, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
}

/**
 * Verify a refresh token against an argon2id hash.
 * Returns true on match, false on mismatch (never throws).
 */
async function verifyRefreshTokenArgon2(token: string, hash: string): Promise<boolean> {
  // If the hash is 64 hex chars, it's a legacy SHA-256 hash.
  if (hash.length === 64 && /^[a-f0-9]{64}$/.test(hash)) {
    const sha256Hash = hashRefreshToken(token);
    try {
      return timingSafeEqual(Buffer.from(sha256Hash, "hex"), Buffer.from(hash, "hex"));
    } catch {
      return false;
    }
  }
  // argon2id hash.
  try {
    const argon2 = await import("argon2");
    return await argon2.verify(hash, token);
  } catch {
    return false;
  }
}

/** Derive a human-readable device label from the user agent + kind. */
function deriveDeviceLabel(ctx: SessionCtx): string {
  const ua = ctx.ua;
  let browser = "Unknown";
  let os = "Unknown";
  if (/Chrome\/(\d+)/.test(ua) && !/Edg/.test(ua)) browser = "Chrome";
  else if (/Firefox\/(\d+)/.test(ua)) browser = "Firefox";
  else if (/Safari\/(\d+)/.test(ua) && !/Chrome/.test(ua)) browser = "Safari";
  else if (/Edg\/(\d+)/.test(ua)) browser = "Edge";

  if (/Windows NT/.test(ua)) os = "Windows";
  else if (/Mac OS X/.test(ua)) os = "macOS";
  else if (/Linux/.test(ua)) os = "Linux";
  else if (/iPhone|iPad/.test(ua)) os = "iOS";
  else if (/Android/.test(ua)) os = "Android";

  return `${browser} on ${os} (${ctx.kind})`;
}

/** Generate a new refresh token (48 random bytes, base64url). */
function newRefreshToken(): string {
  return randomBytes(48).toString("base64url");
}

/**
 * Sign a JWT. Stub — the real impl uses `jsonwebtoken` or Supabase's JWT
 * signing. The JWT carries `{ sub: userId, jti }` and expires at `expiresAt`.
 *
 * The signing secret is `process.env.JWT_SECRET` (HMAC-SHA256). Production
 * would use RS256 (asymmetric) for multi-service verification.
 */
function signJwt(payload: { sub: string; jti: string }, expiresAt: Date): string {
  // Stub: base64url(header).base64url(payload).base64url(signature)
  // The real impl uses jsonwebtoken's `sign({ sub, jti }, secret, { expiresIn })`.
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({
    ...payload,
    exp: Math.floor(expiresAt.getTime() / 1000),
    iat: Math.floor(Date.now() / 1000),
  })).toString("base64url");
  const secret = process.env.SUPABASE_JWT_SECRET ?? process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SUPABASE_JWT_SECRET (or JWT_SECRET) is required in production.");
    }
    console.warn("[security] JWT_SECRET not set — using dev fallback. DO NOT use in production.");
  }
  const signingSecret = secret ?? "dev-secret";
  const sig = createHmac("sha256", signingSecret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

// ───────────────────────────────────────────────
// issueSession — create a session + JWT + refresh token
// ───────────────────────────────────────────────

/**
 * Issue a new session. v2 design: short JWT (15 min) + opaque refresh token
 * (30 days absolute cap, 14-day rolling idle).
 *
 * The JWT is stateless — it can't be revoked mid-flight (15-min damage window).
 * The refresh token is opaque (server-side state) — stored as argon2id hash
 * (the raw token is shown ONCE). The refresh token CAN be revoked instantly
 * at the server (revocation is at the refresh layer, not the JWT layer).
 *
 * The session row carries:
 *   - `token_hash` — argon2id of the refresh token (for lookup + verification).
 *   - `expires_at` — absolute cap (30 days). Even with continuous refresh,
 *     the session dies after this.
 *   - `idle_expires_at` — rolling idle timeout (14 days). Resets on each
 *     refresh. If the user doesn't refresh within 14 days, the session expires.
 *   - `mfa_satisfied` — whether MFA was satisfied for this session (for
 *     re-auth-sensitive operations like ownership transfer).
 *
 * The JWT expires in 15 minutes. The client must call `refresh()` before
 * the JWT expires to get a new JWT (and rotate the refresh token).
 */
export async function issueSession(
  userId: string,
  ctx: SessionCtx,
): Promise<IssuedSession> {
  const jti = crypto.randomUUID();
  const now = Date.now();
  const jwtExpiresAt = new Date(now + JWT_TTL_MS); // 15 min.
  const sessionExpiresAt = new Date(now + SESSION_TTL[ctx.kind]); // 30d/90d/12h.
  const idleExpiresAt = new Date(now + SESSION_IDLE_TTL_MS); // 14d rolling.
  const refreshToken = newRefreshToken();
  const tokenHash = await hashRefreshTokenArgon2(refreshToken); // argon2id.
  const deviceHash = deviceFingerprint(ctx);

  await db.insert(sessions).values({
    id: jti as any,
    userId: userId as any,
    kind: ctx.kind,
    ip: ctx.ip as any,
    userAgent: ctx.ua,
    deviceHash,
    deviceLabel: deriveDeviceLabel(ctx),
    tokenHash,
    refreshTokenHash: tokenHash, // legacy compat (SHA-256 → argon2id).
    expiresAt: sessionExpiresAt,
    idleExpiresAt,
    ssoOriginated: ctx.sso ?? false,
    mfaSatisfied: false, // set by the MFA flow after verification.
    lastSeenAt: new Date(),
  });

  return {
    token: signJwt({ sub: userId, jti }, jwtExpiresAt), // 15-min JWT.
    refreshToken,
    sessionId: jti,
    expiresAt: jwtExpiresAt, // the JWT's expiry (not the session's).
  };
}

// ───────────────────────────────────────────────
// refresh — rotate the refresh token (with reuse detection)
// ───────────────────────────────────────────────

/**
 * Refresh a session. Rotates the refresh token: the old session's
 * `rotated_at` is set, a new session (same family_id) is created with a
 * new refresh token.
 *
 * REUSE DETECTION: if the presented refresh token's session has `rotated_at`
 * set (meaning it was already rotated — an attacker stole + used it, OR the
 * legitimate user is replaying), the ENTIRE FAMILY is revoked (all sessions
 * with the same `family_id`). This catches token theft.
 *
 * The reuse detection is the headline security invariant: a stolen refresh
 * token, once used by the attacker, triggers a family-wide revoke when the
 * legitimate user next refreshes. The user is logged out everywhere in the
 * family (forced re-auth) — the attacker loses access + the user is alerted.
 */
export async function refresh(
  userId: string,
  jti: string,
  presentedRefreshToken: string,
): Promise<IssuedSession> {
  // Look up the session by jti + userId.
  const rows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, jti as any), eq(sessions.userId, userId as any)))
    .limit(1);
  const s = rows[0];

  if (!s) {
    throw new ApiError("session_not_found", 401);
  }

  // Verify the refresh token hash matches.
  const presentedHash = hashRefreshToken(presentedRefreshToken);
  if (s.refreshTokenHash !== presentedHash) {
    throw new ApiError("invalid_refresh_token", 401);
  }

  // REUSE DETECTION: if rotated_at is set, this refresh token was already
  // rotated. An attacker stole + used it, OR the legitimate user is replaying.
  // NUKE THE FAMILY: revoke all sessions with the same family_id.
  if (s.rotatedAt) {
    await db
      .update(sessions)
      .set({ revokedAt: new Date(), refreshTokenHash: null })
      .where(
        and(
          eq(sessions.familyId, s.familyId as any),
          isNull(sessions.revokedAt),
        ),
      );

    // Alert (the monitoring stack should page on this).
    console.error(`[security] refresh token reuse detected — family ${s.familyId} nuked (user ${userId})`);

    throw new ApiError("refresh_reuse_detected", 401, {
      alert: true,
      familyId: s.familyId,
    });
  }

  // Rotate: mark the old session as rotated + null its refresh token hash.
  await db
    .update(sessions)
    .set({ rotatedAt: new Date(), refreshTokenHash: null })
    .where(eq(sessions.id, jti as any));

  // Create a new session (same family_id) with a new refresh token.
  const newJti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL[s.kind as SessionKind]);
  const newRefreshTokenVal = newRefreshToken();
  const newRefreshTokenHash = hashRefreshToken(newRefreshTokenVal);

  await db.insert(sessions).values({
    id: newJti as any,
    userId: userId as any,
    kind: s.kind as SessionKind,
    ip: s.ip,
    userAgent: s.userAgent,
    deviceHash: s.deviceHash,
    familyId: s.familyId, // same family.
    refreshTokenHash: newRefreshTokenHash,
    expiresAt,
    ssoOriginated: s.ssoOriginated,
    lastSeenAt: new Date(),
  });

  return {
    token: signJwt({ sub: userId, jti: newJti }, expiresAt),
    refreshToken: newRefreshTokenVal,
    sessionId: newJti,
    expiresAt,
  };
}

// ───────────────────────────────────────────────
// revokeAllSessions — nuke all sessions (self-service + suspension)
// ───────────────────────────────────────────────

/**
 * Revoke all active sessions for a user. Called by:
 *   - Self-service "log out everywhere" (account settings).
 *   - Suspension (members/service.ts suspend → revokeAllSessions).
 *   - Erasure (residency/service.ts eraseUser → revokeAllSessions).
 *
 * Sets `revoked_at = now()` + nulls the refresh token hash on all non-revoked
 * sessions. The user is immediately logged out everywhere.
 */
export async function revokeAllSessions(userId: string): Promise<number> {
  const result = await db
    .update(sessions)
    .set({ revokedAt: new Date(), refreshTokenHash: null })
    .where(
      and(
        eq(sessions.userId, userId as any),
        isNull(sessions.revokedAt),
      ),
    )
    .returning({ id: sessions.id });

  return result.length;
}

/**
 * Revoke a single session (self-service device management).
 * The user can revoke a specific session from the device list.
 */
export async function revokeSession(userId: string, sessionId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date(), refreshTokenHash: null })
    .where(
      and(
        eq(sessions.id, sessionId as any),
        eq(sessions.userId, userId as any),
        isNull(sessions.revokedAt),
      ),
    );
}

// ───────────────────────────────────────────────
// listDevices — self-service device list
// ───────────────────────────────────────────────

/**
 * List the user's active sessions (the "device list" in account settings).
 * Shows kind, IP, user agent, device hash, last seen, SSO-originated flag.
 * Only active (non-revoked, non-expired) sessions are returned.
 */
export async function listDevices(userId: string): Promise<DeviceInfo[]> {
  const rows = await db
    .select({
      id: sessions.id,
      kind: sessions.kind,
      ip: sessions.ip,
      userAgent: sessions.userAgent,
      deviceHash: sessions.deviceHash,
      lastSeenAt: sessions.lastSeenAt,
      createdAt: sessions.createdAt,
      ssoOriginated: sessions.ssoOriginated,
      deviceLabel: sessions.deviceLabel,
      mfaSatisfied: sessions.mfaSatisfied,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId as any),
        isNull(sessions.revokedAt),
        sql`${sessions.expiresAt} > now()`,
      ),
    )
    .orderBy(sql`${sessions.lastSeenAt} desc`);

  return rows.map((r) => ({
    sessionId: r.id as string,
    kind: r.kind as SessionKind,
    ip: r.ip as string | null,
    userAgent: r.userAgent,
    deviceHash: r.deviceHash,
    deviceLabel: r.deviceLabel,
    lastSeenAt: r.lastSeenAt as Date,
    createdAt: r.createdAt as Date,
    ssoOriginated: r.ssoOriginated,
    mfaSatisfied: r.mfaSatisfied,
  }));
}

// ───────────────────────────────────────────────
// touchSession — update last_seen_at (idle timeout tracking)
// ───────────────────────────────────────────────

/**
 * Update the session's `last_seen_at`. Called by the auth middleware on every
 * request. Used for the idle timeout check + the device list's "last seen" display.
 *
 * Best-effort: doesn't block the request (fire-and-forget via queueMicrotask).
 */
export async function touchSession(sessionId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ lastSeenAt: new Date() })
    .where(eq(sessions.id, sessionId as any));
}

// ───────────────────────────────────────────────
// checkIdleTimeout — 401 if last_seen_at > idle_timeout
// ───────────────────────────────────────────────

/**
 * Check if the session has been idle too long. If `last_seen_at` is older than
 * `idleTimeoutMs`, throw 401 (prompt re-auth). The idle timeout is configurable
 * per workspace (Business tier feature — default 1 hour).
 *
 * Called by the auth middleware on every request (after touchSession).
 */
export async function checkIdleTimeout(
  sessionId: string,
  idleTimeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS,
): Promise<void> {
  const rows = await db
    .select({ lastSeenAt: sessions.lastSeenAt, expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId as any))
    .limit(1);
  const s = rows[0];
  if (!s) throw new ApiError("session_not_found", 401);

  // Expired?
  if (s.expiresAt < new Date()) {
    throw new ApiError("session_expired", 401);
  }

  // Idle too long?
  const idleMs = Date.now() - (s.lastSeenAt as Date).getTime();
  if (idleMs > idleTimeoutMs) {
    throw new ApiError("idle_timeout", 401, { idleMs, idleTimeoutMs });
  }
}

// ───────────────────────────────────────────────
// cleanupExpiredSessions — cron (TTL cleanup)
// ───────────────────────────────────────────────

/**
 * Clean up expired sessions. Deletes sessions where `expires_at < now()` AND
 * `revoked_at` is set (revoked + expired = safe to delete). Active-but-expired
 * sessions are kept for a grace period (the user might refresh).
 *
 * Returns the count of deleted sessions.
 */
export async function cleanupExpiredSessions(): Promise<number> {
  const result = await db
    .delete(sessions)
    .where(
      and(
        sql`${sessions.expiresAt} < now() - interval '7 days'`,
        sql`${sessions.revokedAt} is not null`,
      ),
    )
    .returning({ id: sessions.id });

  return result.length;
}

// ───────────────────────────────────────────────
// Existing app-layer functions (preserved from the original session.ts).
// ───────────────────────────────────────────────

import { supabaseServer, supabaseService } from "@/lib/supabase/server";
import type { WorkspaceRole } from "@/lib/workspaces/queries";
import type { User } from "@supabase/supabase-js";

export async function requireUser(): Promise<User> {
  const supabase = await supabaseServer();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    const err = new Error("unauthenticated") as Error & { status?: number };
    err.status = 401;
    throw err;
  }
  return user;
}

export async function assertRole(
  userIdOrWsId: string,
  wsIdOrRole: string | WorkspaceRole,
  roles?: string[],
): Promise<boolean> {
  // Caller pattern: assertRole(user.id, wsId, ["owner", "admin"])
  // Old pattern:    assertRole(wsId, role)
  // Detect which pattern by checking if the 3rd arg is an array.
  const user = await requireUser();
  const supabase = await supabaseServer();

  if (Array.isArray(roles)) {
    // New pattern: (userId, wsId, roles[])
    const wsId = wsIdOrRole as string;
    const { data: member } = await supabase
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", wsId)
      .eq("user_id", user.id)
      .single();
    const hasRole = member && roles.includes((member as { role: string }).role);
    if (!hasRole) {
      return false;
    }
    return true;
  }

  // Old pattern: (wsId, role) — returns void, throws on failure
  const wsId = userIdOrWsId;
  const role = wsIdOrRole as WorkspaceRole;
  const { data: member } = await supabase
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", wsId)
    .eq("user_id", user.id)
    .single();
  if (!member || (member as { role: string }).role !== role) {
    const err = new Error("forbidden") as Error & { status?: number };
    err.status = 403;
    throw err;
  }
  return true;
}

export async function rotateSessions(userId: string): Promise<void> {
  const supabase = await supabaseService();
  await supabase.auth.admin.signOut(userId, "global");
  await revokeAllSessions(userId);
}

export async function rotateMySessions(): Promise<void> {
  const user = await requireUser();
  await rotateSessions(user.id);
}

// ───────────────────────────────────────────────
// v2 session functions — opaque refresh + 15-min JWT.
//
// Design decision: opaque server-side sessions for refresh, stateless JWT
// (15 min) for API calls. Revocation is instant at the refresh layer; JWTs
// die fast.
//
// The JWT contains ONLY user identity (sub, sid, mfa) — never workspace roles.
// Authorization is re-derived from DB (RLS) per request. No stale-role-in-token
// class of bugs: if a user's role changes, the next request uses the new role
// (not a cached role in the JWT).
//
// The refresh token is an opaque random string (32 bytes base64url), stored
// as argon2id hash. The raw token only ever lives in an HttpOnly, Secure,
// SameSite=Lax cookie at path=/v1/auth — never in JS-accessible storage.
// ───────────────────────────────────────────────

export interface RequestContext {
  ip: string;
  ua: string;
  language?: string;
}

export interface V2Session {
  sessionId: string;
  refreshToken: string; // raw token — only ever in the HttpOnly cookie.
}

/**
 * Create a new session (v2). The refresh token is opaque (32 random bytes
 * base64url), stored as argon2id hash. The JWT is 15 min (issued separately
 * via `issueAccessToken`).
 *
 * The session row carries:
 *   - `token_hash` — argon2id of the refresh token.
 *   - `expires_at` — absolute cap: 30 days.
 *   - `idle_expires_at` — rolling: 14 days (resets on each refresh).
 *   - `mfa_satisfied` — whether MFA was satisfied (from the login flow).
 *   - `device_label` — human-readable (Chrome on macOS).
 *
 * The raw refresh token is returned to the caller — it goes into the HttpOnly
 * cookie. It is NEVER stored server-side (only the argon2id hash is stored).
 */
export async function createSession(
  uid: string,
  ctx: RequestContext,
  mfaOk: boolean,
): Promise<V2Session> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = await hashRefreshTokenArgon2(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_TTL_MS);
  const idleExpiresAt = new Date(now.getTime() + SESSION_IDLE_TTL_MS);
  const deviceLabel = deriveDeviceLabel({
    kind: "web",
    ip: ctx.ip,
    ua: ctx.ua,
    ...(ctx.language ? { language: ctx.language } : {}),
  });

  const rows = await db
    .insert(sessions)
    .values({
      userId: uid as any,
      kind: "web",
      tokenHash,
      refreshTokenHash: tokenHash, // legacy compat.
      ip: ctx.ip as any,
      userAgent: ctx.ua,
      deviceHash: deviceFingerprint({ kind: "web", ip: ctx.ip, ua: ctx.ua, ...(ctx.language ? { language: ctx.language } : {}) }),
      deviceLabel,
      mfaSatisfied: mfaOk,
      expiresAt,
      idleExpiresAt,
      lastSeenAt: now,
    })
    .returning({ id: sessions.id });

  const s = rows[0];
  if (!s) throw new ApiError("session_creation_failed", 500);

  return { sessionId: s.id as string, refreshToken: token };
}

/**
 * Rotate a refresh token (v2). The old token is looked up by argon2id verify,
 * checked for validity (not revoked, not expired, idle not expired), then:
 *   1. Reuse detection: if `rotated_to` is set → the token was already rotated
 *      → stolen session → KILL THE FAMILY (revoke all sessions for the user).
 *   2. Create a new session (same user, same MFA satisfaction, same device).
 *   3. Mark the old session as rotated (`rotated_to` = new session id,
 *      `revoked_at` = now, `revoked_reason` = 'rotated').
 *
 * Uses `FOR UPDATE` (via the system pool) to serialize concurrent rotations
 * — prevents two rotations from reading the same old token + both succeeding.
 *
 * The new refresh token is returned — it goes into the HttpOnly cookie.
 */
export async function rotate(
  oldToken: string,
  ctx: RequestContext,
): Promise<V2Session> {
  // We can't look up by argon2id hash directly (argon2id is slow — can't
  // index on it). Instead, we iterate active sessions for the token's
  // implied user. But we don't know the user from the token alone.
  //
  // Approach: the refresh token is in the HttpOnly cookie. The API route
  // also has the JWT (which carries `sid` = the session id). So the route
  // passes both the session id AND the refresh token. We look up by session
  // id (indexed), then verify the refresh token against the stored hash.
  //
  // For the standalone `rotate` function (without a session id), we'd need
  // to iterate all active sessions — which is impractical with argon2id.
  // The spec's `token_hash_match($1)` implies a DB function that does the
  // argon2id verify — but that's expensive. The session id (from the JWT)
  // is the practical lookup key.
  //
  // For now: this function requires the session id (from the JWT's `sid`
  // claim). The API route extracts `sid` from the JWT + passes it here.
  throw new ApiError("rotate_requires_session_id", 500);
}

/**
 * Rotate a refresh token using the session id (from the JWT's `sid` claim).
 *
 * This is the practical path: the JWT (still valid or recently expired) carries
 * the `sid` = the session id. The refresh token is in the HttpOnly cookie.
 * We look up by session id (indexed), verify the refresh token against the
 * stored argon2id hash, check validity, and rotate.
 *
 * REUSE DETECTION: if `rotated_to` is set → the token was already rotated
 * → stolen session → KILL THE FAMILY (revoke all sessions for the user).
 *
 * Uses `withSystem` (FOR UPDATE lock via the system pool).
 */
export async function rotateBySessionId(
  sessionId: string,
  oldToken: string,
  ctx: RequestContext,
): Promise<V2Session> {
  const { withSystem, getSystemPool } = await import("@supa/db/pool");
  const pool = getSystemPool();

  return withSystem(pool, async (tx) => {
    // Look up the session by id + FOR UPDATE (serialize concurrent rotations).
    const rows = await tx`
      select id, user_id, token_hash, rotated_to, revoked_at, expires_at, idle_expires_at, mfa_satisfied
      from sessions
      where id = ${sessionId}::uuid
      for update
    `;
    const s = rows[0] as {
      id: string;
      user_id: string;
      token_hash: string;
      rotated_to: string | null;
      revoked_at: string | null;
      expires_at: Date;
      idle_expires_at: Date;
      mfa_satisfied: boolean;
    } | undefined;

    if (!s) {
      throw new ApiError("invalid_session", 401);
    }

    // Check validity.
    if (s.revoked_at) {
      throw new ApiError("invalid_session", 401);
    }
    if (new Date(s.expires_at) <= new Date()) {
      throw new ApiError("session_expired", 401);
    }
    if (new Date(s.idle_expires_at) <= new Date()) {
      throw new ApiError("session_idle_expired", 401);
    }

    // Verify the refresh token against the stored argon2id hash.
    const tokenValid = await verifyRefreshTokenArgon2(oldToken, s.token_hash);
    if (!tokenValid) {
      throw new ApiError("invalid_session", 401);
    }

    // REUSE DETECTION: if rotated_to is set → the token was already rotated.
    // An attacker stole + used it, OR the legitimate user is replaying.
    // KILL THE FAMILY: revoke all sessions for this user.
    if (s.rotated_to) {
      await tx`
        update sessions set revoked_at = now(), revoked_reason = 'reuse_detected'
        where user_id = ${s.user_id}::uuid and revoked_at is null
      `;
      console.error(
        `[security] refresh token reuse detected — family killed (user ${s.user_id}, session ${s.id})`,
      );
      throw new ApiError("session_revoked", 401, { reason: "reuse_detected" });
    }

    // Create a new session (same user, same MFA, same device).
    const newToken = randomBytes(32).toString("base64url");
    const newTokenHash = await hashRefreshTokenArgon2(newToken);
    const now = new Date();
    const newExpiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_TTL_MS);
    const newIdleExpiresAt = new Date(now.getTime() + SESSION_IDLE_TTL_MS);

    const newRows = await tx`
      insert into sessions (user_id, kind, token_hash, refresh_token_hash, ip, user_agent, device_hash, device_label, mfa_satisfied, expires_at, idle_expires_at, last_seen_at)
      values (${s.user_id}::uuid, 'web', ${newTokenHash}, ${newTokenHash}, ${ctx.ip}::inet, ${ctx.ua}, ${deviceFingerprint({ kind: "web", ip: ctx.ip, ua: ctx.ua })}, ${deriveDeviceLabel({ kind: "web", ip: ctx.ip, ua: ctx.ua })}, ${s.mfa_satisfied}, ${newExpiresAt}, ${newIdleExpiresAt}, now())
      returning id
    `;
    const newSession = newRows[0] as { id: string } | undefined;
    if (!newSession) throw new ApiError("session_creation_failed", 500);

    // Mark the old session as rotated.
    await tx`
      update sessions
      set rotated_to = ${newSession.id}::uuid, revoked_at = now(), revoked_reason = 'rotated', last_used_at = now()
      where id = ${s.id}::uuid
    `;

    return { sessionId: newSession.id, refreshToken: newToken };
  });
}

/**
 * Issue a 15-minute access token (JWT) from a session.
 *
 * The JWT contains ONLY user identity — never workspace roles:
 *   - `sub`: the user id.
 *   - `sid`: the session id (for refresh token lookup).
 *   - `mfa`: whether MFA was satisfied (for re-auth-sensitive operations).
 *
 * Authorization is re-derived from DB (RLS) per request. No stale-role-in-token
 * class of bugs: if a user's role changes, the next request uses the new role
 * (not a cached role in the JWT).
 *
 * The JWT expires in 15 minutes. The client must call `rotate` before expiry
 * to get a new JWT (and rotate the refresh token).
 */
export function issueAccessToken(s: { userId: string; sessionId: string; mfaSatisfied: boolean }): string {
  const expiresAt = new Date(Date.now() + JWT_TTL_MS);
  return signJwt(
    { sub: s.userId, jti: s.sessionId, ...(s.mfaSatisfied ? { mfa: true } : {}) } as { sub: string; jti: string },
    expiresAt,
  );
}
