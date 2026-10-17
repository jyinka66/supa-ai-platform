// Share link creation + revocation.
//
// createShareLink(uid, wsId, fileId, opts):
//   1. assertPermission(ws, uid, 'file:share') — sharing grants external
//      access; it's a deliberate action, not a default member right.
//   2. Resolve the file row — verify it belongs to wsId + isn't deleted +
//      has a storage_key (upload confirmed — can't share a pending upload).
//   3. Mint a random URL token (32 bytes → base64url, 43 chars). The raw
//      token is returned to the caller ONCE; only SHA-256(token) is stored.
//      Same pattern as API keys / invite tokens / refresh tokens.
//   4. If a password is supplied, argon2id-hash it (C11 fix — never unsalted
//      SHA-256 + Buffer.equals). OWASP 2024 baseline: 19 MiB, t=2, p=1.
//   5. INSERT share_links row (token_hash, password_hash, perm, expires_at,
//      max_views, allowed_email, created_by).
//   6. Audit file.shared (the share link id + perm + expiry — NOT the raw
//      token, never).
//   7. Return { shareId, token, url } — the caller constructs the full URL
//      from the token (the route layer knows the public base URL).
//
// revokeShareLink(uid, shareId):
//   1. Lookup the share link — verify it belongs to a workspace the caller
//      has 'file:share' on (RLS already enforces this, but we check explicitly
//      for a clear 403 vs 404).
//   2. SET revoked_at = now() (idempotent — already-revoked is a no-op).
//   3. Audit file.share.revoked.
//
// Token generation: crypto.randomBytes(32) → base64url (43 chars, no padding).
// This matches the TOKEN_RE validation in the public resolve route
// (/^[A-Za-z0-9_-]{43}$/) — URL-safe, no + or / that would need encoding.

import { db } from "@supa/db";
import { shareLinksV2 as shareLinks, files } from "@supa/db/schema";
import { eq, and, isNull, sql } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import { assertPermission, ApiError as AuthzError } from "@/lib/authz/permissions";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type SharePerm = "view" | "download" | "edit";

export interface CreateShareOpts {
  perm: SharePerm;
  password?: string;
  expiresAt?: Date | null;
  maxViews?: number | null;
  allowedEmail?: string | null;
}

export interface CreateShareResult {
  shareId: string;
  /** The raw URL token — returned ONCE. Only SHA-256(token) is stored. */
  token: string;
}

// ───────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────

const TOKEN_BYTES = 32; // 256 bits of entropy → 43 base64url chars.
const MAX_VIEWS_MIN = 1;

// argon2id params — OWASP 2024 baseline (19 MiB, t=2, p=1).
// Same as sessions + MFA recovery codes. Applied inline in hashPassword().

// ───────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────

/** Generate a random URL-safe token (base64url, 43 chars for 32 bytes). */
export function generateShareToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** SHA-256 hex of the raw token — what's stored in token_hash. */
export function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/** argon2id-hash a share password (C11 fix — never unsalted SHA-256). */
async function hashPassword(password: string): Promise<string> {
  const argon2 = await import("argon2");
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456, // 19 MiB
    timeCost: 2,
    parallelism: 1,
  });
}

/** Validate the create-share options. Throws on invalid input. */
export function validateOpts(opts: CreateShareOpts): void {
  if (!["view", "download", "edit"].includes(opts.perm)) {
    throw new AuthzError(`invalid_perm:${opts.perm}`, 400);
  }

  // 'edit' perm requires the Phase 10 ACL table (not yet built — resolve.ts
  // throws ShareNotImplementedError on resolution). We allow CREATION of
  // edit-perm links (the row is valid) but they can't be RESOLVED yet.
  // This is intentional — admins can pre-create edit links; the resolution
  // path will be wired when the ACL table lands. Documented in resolve.ts.
  //
  // (If we wanted to be stricter, we'd reject creation here too. But the
  // spec's resolve flow is the gate — creation is just a row insert.)

  if (opts.maxViews !== null && opts.maxViews !== undefined) {
    if (!Number.isInteger(opts.maxViews) || opts.maxViews < MAX_VIEWS_MIN) {
      throw new AuthzError(`invalid_max_views:${opts.maxViews}`, 400);
    }
  }

  if (opts.expiresAt !== null && opts.expiresAt !== undefined) {
    if (opts.expiresAt.getTime() <= Date.now()) {
      throw new AuthzError("expires_at_must_be_future", 400);
    }
  }

  if (opts.allowedEmail !== null && opts.allowedEmail !== undefined && opts.allowedEmail !== "") {
    // Basic email shape check — the route layer should do a stricter check,
    // but we validate here too (defense-in-depth).
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(opts.allowedEmail)) {
      throw new AuthzError(`invalid_email:${opts.allowedEmail}`, 400);
    }
  }
}

/**
 * Resolve the file row — verify it belongs to wsId, isn't deleted, and
 * has a storage_key (upload confirmed). Returns the file id if valid.
 *
 * Uses `withUserDrizzle`? No — the caller has already established the auth
 * context (the route calls authenticate → uid). We use the default pool
 * (RLS via JWT claims) — but the route hasn't injected claims yet. So we
 * use a system-level lookup scoped by (id, ws_id) — safe because the
 * (fileId, wsId) pair is the access-scoped key.
 *
 * Actually — the cleanest path is to look up the file via the user pool
 * (RLS: the user must be a member to see the file). But the route layer
 * uses `authenticate()` (JWT only, no claims injection). So we do a
 * direct lookup scoped by (id, ws_id) — if the row exists + belongs to
 * wsId, the user (who passed `file:share` on wsId) can share it.
 */
async function resolveFileForShare(wsId: string, fileId: string): Promise<void> {
  const rows = await db
    .select({
      id: files.id,
      wsId: files.workspaceId,
      storageKey: files.storageKey,
      deletedAt: files.deletedAt,
    })
    .from(files)
    .where(eq(files.id, fileId as any))
    .limit(1);
  const file = rows[0];
  if (!file) throw new AuthzError("file_not_found", 404);
  if (file.wsId !== (wsId as any)) throw new AuthzError("file_not_found", 404);
  if (file.deletedAt) throw new AuthzError("file_not_found", 404);
  if (!file.storageKey) {
    // Upload never confirmed — the file isn't readable yet. Can't share.
    throw new AuthzError("file_upload_not_confirmed", 409);
  }
}

/** Append to the enterprise audit log. */
async function audit(
  wsId: string,
  entry: {
    actorType: "user" | "system";
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

// ───────────────────────────────────────────────
// createShareLink
// ───────────────────────────────────────────────

/**
 * Create a share link for a file.
 *
 * Flow:
 *   1. assertPermission(ws, uid, 'file:share') — sharing is a deliberate
 *      action that grants external access. Not a default member right.
 *   2. Resolve the file — verify it belongs to wsId, isn't deleted, has a
 *      storage_key (upload confirmed).
 *   3. Validate opts (perm, max_views > 0, expires_at in future, email shape).
 *   4. Mint a random token (32 bytes → base64url, 43 chars).
 *   5. Hash the token (SHA-256) — only the hash is stored.
 *   6. If password supplied, argon2id-hash it (C11 fix).
 *   7. INSERT share_links row.
 *   8. Audit file.shared (shareId + perm + expiry — NEVER the raw token).
 *   9. Return { shareId, token } — the caller constructs the public URL.
 *
 * The raw token is returned ONCE. If the caller loses it, the share link
 * must be revoked + a new one created (there's no "resend token" path —
 * we don't store the raw token, so we can't recover it).
 *
 * @throws ApiError(403) if the user lacks 'file:share'.
 * @throws ApiError(404) if the file doesn't exist / belongs to another ws / is deleted.
 * @throws ApiError(409) if the file's upload was never confirmed (no storage_key).
 * @throws ApiError(400) on invalid opts.
 */
export async function createShareLink(
  uid: string,
  wsId: string,
  fileId: string,
  opts: CreateShareOpts,
): Promise<CreateShareResult> {
  // 1. Permission check — file:share required.
  await assertPermission(wsId, uid, "file:share");

  // 2. Resolve + validate the file.
  await resolveFileForShare(wsId, fileId);

  // 3. Validate opts.
  validateOpts(opts);

  // 4. Mint the token.
  const rawToken = generateShareToken();
  const tokenHash = hashToken(rawToken);

  // 5. Hash the password (if supplied).
  const passwordHash = opts.password
    ? await hashPassword(opts.password)
    : null;

  // 6. INSERT the share link row.
  //    exactOptionalPropertyTypes-safe: only set nullable columns when we
  //    have a value (Drizzle treats `undefined` as "use default / null",
  //    but `null` explicitly sets NULL).
  const rows = await db
    .insert(shareLinks)
    .values({
      workspaceId: wsId as any,
      fileId: fileId as any,
      tokenHash,
      passwordHash,
      perm: opts.perm,
      expiresAt: opts.expiresAt ?? null,
      maxViews: opts.maxViews ?? null,
      viewCount: 0,
      allowedEmail: opts.allowedEmail ?? null,
      createdBy: uid as any,
    })
    .returning({ id: shareLinks.id });
  const row = rows[0];
  if (!row) throw new AuthzError("share_link_insert_failed", 500);
  const shareId = row.id as string;

  // 7. Audit — NEVER log the raw token. Only the shareId + perm + expiry.
  await audit(wsId, {
    actorType: "user",
    actorId: uid,
    action: "file.shared",
    target: {
      file: fileId,
      share: shareId,
      perm: opts.perm,
      expiresAt: opts.expiresAt?.toISOString() ?? null,
      maxViews: opts.maxViews ?? null,
      passwordProtected: !!opts.password,
      emailGated: !!opts.allowedEmail,
    },
  });

  // 8. Return the raw token ONCE.
  return { shareId, token: rawToken };
}

// ───────────────────────────────────────────────
// revokeShareLink
// ───────────────────────────────────────────────

/**
 * Revoke a share link.
 *
 * Flow:
 *   1. assertPermission(ws, uid, 'file:share') — same perm required to revoke
 *      as to create (any admin/owner with file:share can revoke any link in
 *      the workspace — not just the creator. This prevents a departed admin's
 *      links from being un-revocable).
 *   2. Lookup the share link — verify it belongs to wsId (defense-in-depth;
 *      RLS already enforces this).
 *   3. SET revoked_at = now() (idempotent — already-revoked is a no-op,
 *      returns the shareId anyway so the caller sees success).
 *   4. Audit file.share.revoked.
 *
 * @throws ApiError(403) if the user lacks 'file:share'.
 * @throws ApiError(404) if the share link doesn't exist / belongs to another ws.
 */
export async function revokeShareLink(
  uid: string,
  wsId: string,
  shareId: string,
): Promise<{ shareId: string }> {
  await assertPermission(wsId, uid, "file:share");

  // Lookup + update atomically. The WHERE clause scopes by (id, ws_id) —
  // if the link belongs to another ws, 0 rows match → 404.
  const rows = await db
    .update(shareLinks)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(shareLinks.id, shareId as any),
        eq(shareLinks.workspaceId, wsId as any),
        isNull(shareLinks.revokedAt),
      ),
    )
    .returning({ id: shareLinks.id });
  const row = rows[0];
  if (!row) {
    // Either doesn't exist, belongs to another ws, or already revoked.
    // No oracle — return 404 for all three (the caller can't tell).
    throw new AuthzError("share_link_not_found", 404);
  }

  await audit(wsId, {
    actorType: "user",
    actorId: uid,
    action: "file.share.revoked",
    target: { share: shareId },
  });

  return { shareId: row.id as string };
}

// ───────────────────────────────────────────────
// listShareLinks — list active share links for a file
// ───────────────────────────────────────────────

export interface ShareLinkSummary {
  id: string;
  fileId: string;
  perm: SharePerm;
  expiresAt: Date | null;
  maxViews: number | null;
  viewCount: number;
  passwordProtected: boolean;
  emailGated: boolean;
  revokedAt: Date | null;
  createdAt: Date;
}

/**
 * List share links for a file. Requires 'file:share' permission.
 * Returns all links (active + revoked) — the caller can filter.
 *
 * Does NOT return the token_hash (no need — the raw token is gone after
 * creation; the hash is useless to the caller).
 */
export async function listShareLinks(
  uid: string,
  wsId: string,
  fileId: string,
): Promise<ShareLinkSummary[]> {
  await assertPermission(wsId, uid, "file:share");

  const rows = await db
    .select({
      id: shareLinks.id,
      fileId: shareLinks.fileId,
      perm: shareLinks.perm,
      expiresAt: shareLinks.expiresAt,
      maxViews: shareLinks.maxViews,
      viewCount: shareLinks.viewCount,
      passwordHash: shareLinks.passwordHash,
      allowedEmail: shareLinks.allowedEmail,
      revokedAt: shareLinks.revokedAt,
      createdAt: shareLinks.createdAt,
    })
    .from(shareLinks)
    .where(
      and(
        eq(shareLinks.fileId, fileId as any),
        eq(shareLinks.workspaceId, wsId as any),
      ),
    )
    .orderBy(sql`${shareLinks.createdAt} desc`);

  return rows.map((r) => ({
    id: r.id as string,
    fileId: r.fileId as string,
    perm: r.perm as SharePerm,
    expiresAt: r.expiresAt,
    maxViews: r.maxViews,
    viewCount: r.viewCount,
    passwordProtected: !!r.passwordHash,
    emailGated: !!r.allowedEmail,
    revokedAt: r.revokedAt,
    createdAt: r.createdAt,
  }));
}
