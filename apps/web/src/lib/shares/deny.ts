// Denial result for share resolution.
//
// Design principle: NO ORACLE.
//   - revoked == not_found
//   - expired == not_found
//   - wrong email == not_found
//   - exhausted (max_views) == not_found
//
// The viewer must NOT learn whether the link ever existed. Only two denial
// reasons are distinguishable, because the viewer needs to act on them:
//   - "password"  → retry with a password (the link exists, just gated).
//   - "rate_limited" → wait (too many failed password attempts).
//
// Everything else collapses to "not_found" — the link might be revoked,
// expired, exhausted, or simply never existed. The viewer can't tell.

export type DenyReason = "not_found" | "password" | "rate_limited";

export interface Denial {
  ok: false;
  reason: DenyReason;
}

export interface Admitted {
  ok: true;
  perm: "view" | "download";
  url: string;
  fileId: string;
}

export type ResolveResult = Admitted | Denial;

export function deny(reason: DenyReason): Denial {
  return { ok: false, reason };
}

/**
 * Maps a denial reason to an HTTP status code + problem code.
 * Used by the API route to produce the RFC 9457 problem response.
 *
 * not_found     → 404  SHARE_LINK_NOT_FOUND
 * password      → 401  UNAUTHENTICATED  (the viewer must supply a password)
 * rate_limited  → 429  RATE_LIMITED
 *
 * Note: "expired" / "revoked" / "exhausted" all map to not_found → 404.
 * This is intentional — no oracle.
 */
export function denialHttpStatus(d: Denial): { status: number; code: string } {
  switch (d.reason) {
    case "not_found":
      return { status: 404, code: "SHARE_LINK_NOT_FOUND" };
    case "password":
      return { status: 401, code: "UNAUTHENTICATED" };
    case "rate_limited":
      return { status: 429, code: "RATE_LIMITED" };
  }
}
