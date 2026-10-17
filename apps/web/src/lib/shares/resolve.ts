// Share resolution flow — the canonical spec.
//
// resolve(token, viewer):
//   1. Lookup by token_hash (SHA-256 of raw URL token — raw never stored).
//   2. revoked / expired / wrong-email / exhausted → deny("not_found").
//      NO ORACLE: the viewer cannot learn whether the link existed.
//   3. password_hash set → argon2id-verify the viewer's password.
//      Wrong password → record failed view → rate-limit after 10 in 15 min.
//   4. Atomic view_count increment (quota-safe — conditional UPDATE).
//   5. perm=view       → presign inline GET (browser renders).
//      perm=download   → presign attachment GET (browser downloads).
//      perm=edit       → NOT YET IMPLEMENTED (Phase 10 ACL table).
//
// ── Fixes from the pasted spec ──
// 1. The spec's viewer type was { ip, email? } but accessed viewer.password.
//    → Extended to { ip, email?, password? }.
// 2. The spec didn't guard `password_hash && !viewer.password` → argon2.verify
//    would throw on undefined input. → Guarded: treat missing password as
//    wrong (record failed view, rate-limit).
// 3. The spec didn't check the return of recordView(... true). If the atomic
//    increment fails (link became invalid concurrently — another viewer
//    hit max_views between our read and write), the spec would happily
//    presign a URL. → Added the check: deny("not_found") if increment fails.
// 4. The spec's `edit` branch referenced Phase 10's ACL table (not yet built).
//    → Throws NotImplemented with a clear TODO + design notes (no silent
//      misgrant, no fake user account).

import { createHash } from "node:crypto";
import { byTokenHash, type ShareLinkRow } from "./by-token";
import { recordView, failedCount } from "./views";
import { presignRead } from "./presign";
import { deny, type ResolveResult } from "./deny";

// Re-export the result type — resolve.ts is the public API surface for this module.
export type { ResolveResult, Admitted, Denial, DenyReason } from "./deny";

// ───────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────

/** Failed-password rate-limit window. */
const RATE_LIMIT_WINDOW_MIN = 15;
/** Max failed-password attempts within the window before rate-limit kicks in. */
const RATE_LIMIT_MAX_FAILURES = 10;

/** Duration constant (spec names this `d15min`). The presign layer enforces. */
const D15MIN_MS = 15 * 60 * 1000;

// ───────────────────────────────────────────────
// Viewer
// ───────────────────────────────────────────────

export interface Viewer {
  ip: string;
  email?: string;
  /** Required only if the link has a password_hash. */
  password?: string;
}

// ───────────────────────────────────────────────
// resolve
// ───────────────────────────────────────────────

export class ShareNotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShareNotImplementedError";
  }
}

/**
 * Resolve a share token to a presigned read URL.
 *
 * Returns a discriminated union:
 *   { ok: true, perm, url, fileId }   — admit (presigned URL ready).
 *   { ok: false, reason }              — deny (not_found | password | rate_limited).
 *
 * The route layer maps this to an HTTP response. No oracle: every invalid
 * state collapses to "not_found" except password + rate_limited (which the
 * viewer needs to act on).
 *
 * @throws ShareNotImplementedError if perm === "edit" (Phase 10 ACL table
 *         not yet built — see inline comment).
 */
export async function resolve(token: string, viewer: Viewer): Promise<ResolveResult> {
  const tokenHash = sha256Hex(token);

  const link = await byTokenHash(tokenHash);
  // No link → not_found (covers: never existed, file deleted CASCADE, upload
  // never confirmed → storage_key null).
  if (!link || link.revokedAt) return deny("not_found");

  // Expired → not_found (no oracle — caller can't distinguish from revoked).
  // Lazy expiry: the nightly sweeper hard-revokes, but resolution checks
  // every time so an expired link is denied even before the sweeper runs.
  if (link.expiresAt && link.expiresAt.getTime() < Date.now()) {
    return deny("not_found");
  }

  // Email-gated: viewer must verify ownership of the allowed_email.
  // (Email verification itself happens out-of-band — the route may set a
  // signed cookie proving ownership. Here we just check the claim.)
  if (link.allowedEmail && viewer.email !== link.allowedEmail) {
    return deny("not_found");
  }

  // Password-gated: argon2id-verify (C11 fix — never unsalted SHA-256).
  if (link.passwordHash) {
    const passwordOk = await verifySharePassword(link.passwordHash, viewer.password);

    if (!passwordOk) {
      // Record the failed attempt (always — for rate-limit counting).
      await recordView(link.id, viewer.ip, false);

      // Rate-limit: > 10 failures in 15 min → rate_limited (not "password").
      // The viewer must wait — repeatedly guessing passwords is futile.
      const failures = await failedCount(link.id, RATE_LIMIT_WINDOW_MIN);
      if (failures > RATE_LIMIT_MAX_FAILURES) {
        return deny("rate_limited");
      }
      return deny("password");
    }
  }

  // Pre-check max_views (fast path — avoids a DB write for already-exhausted
  // links). The atomic increment below is the authoritative gate.
  if (link.maxViews !== null && link.viewCount >= link.maxViews) {
    return deny("not_found");
  }

  // Atomic view admission — the quota gate. record_share_view() does a
  // conditional UPDATE (WHERE view_count < max_views AND not revoked AND
  // not expired). If the link became invalid between our read and this
  // write (concurrent request hit max_views, or admin revoked), the UPDATE
  // matches 0 rows → returns false → we deny.
  //
  // This is the spec's "single UPDATE ... WHERE view_count < max_views".
  const admitted = await recordView(link.id, viewer.ip, true);
  if (!admitted) {
    // Concurrent exhaustion / revocation — the link is no longer valid.
    return deny("not_found");
  }

  // Admit — presign the appropriate URL for the permission.
  return admitByPerm(link);
}

// ───────────────────────────────────────────────
// Permission dispatch
// ───────────────────────────────────────────────

async function admitByPerm(link: ShareLinkRow): Promise<ResolveResult> {
  switch (link.perm) {
    case "view": {
      const { url, fileId } = await presignRead(link, { disposition: "inline" });
      return { ok: true, perm: "view", url, fileId };
    }
    case "download": {
      const { url, fileId } = await presignRead(link, { disposition: "attachment" });
      return { ok: true, perm: "download", url, fileId };
    }
    case "edit": {
      // ── Phase 10 ACL table (NOT YET BUILT) ──
      //
      // The spec: "edit links mint a scoped session principal with ONLY
      // file:write on that file — Phase 10's ACL table gains a system
      // grantee row, expiring with the link. No real user account created."
      //
      // Design (to be implemented):
      //   1. INSERT into `file_acl` (Phase 10): { file_id, grantee_kind:
      //      'share_link', grantee_id: <link.id>, perm: 'write',
      //      expires_at: link.expires_at }.
      //   2. Mint a scoped session token (signed JWT) carrying only:
      //        { sub: 'share:'+link.id, file_id, perm: 'write',
      //          exp: min(link.expires_at, now+15min) }
      //   3. The token's RLS context: `is_share_viewer(file_id, link_id)`
      //      pg function — grants file:write ONLY on this file, nothing else.
      //   4. The token cannot list workspace members, read other files, or
      //      elevate. It's a narrowly-scoped bearer.
      //   5. On link revoke/expiry: the ACL row is deleted (CASCADE from
      //      share_links) → the token's RLS check fails → no further writes.
      //
      // Until the ACL table exists, we MUST NOT silently misgrant edit
      // access. Throw — the route returns 501 Not Implemented.
      throw new ShareNotImplementedError(
        "edit-permission share links require the Phase 10 file ACL table " +
          "(not yet built). view/download links work today.",
      );
    }
    default: {
      // perm CHECK constraint at the DB level guarantees view/download/edit,
      // so this is unreachable. Defensive — deny rather than leak.
      return deny("not_found");
    }
  }
}

// ───────────────────────────────────────────────
// Password verification (argon2id — C11 fix)
// ───────────────────────────────────────────────

/**
 * Verify a share password against its argon2id hash.
 *
 * C11 (CRITICAL) fix: the original spec used unsalted SHA-256 + non-constant-
 * time `Buffer.equals`. We use argon2id (OWASP 2024 baseline: 19 MiB, t=2, p=1)
 * — same params as session refresh tokens + MFA recovery codes. argon2.verify
 * is constant-time internally.
 *
 * If the viewer didn't supply a password, treat as wrong (don't throw — the
 * caller records a failed view + applies the rate-limit).
 */
async function verifySharePassword(hash: string, password?: string): Promise<boolean> {
  if (!password) return false;
  const argon2 = await import("argon2");
  try {
    return await argon2.verify(hash, password);
  } catch {
    // Malformed hash / verification error → treat as wrong password.
    // (Shouldn't happen — the hash was created by our own createShareLink
    // path. But defensive — never leak via error message.)
    return false;
  }
}

// ───────────────────────────────────────────────
// sha256 (hex) — for the raw token. Same impl as auth/tokens.ts but local
// (avoids importing crypto.subtle + the async wrapper into a hot path).
// ───────────────────────────────────────────────

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// Exported for tests + the route.
export { D15MIN_MS };
