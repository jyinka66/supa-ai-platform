// Share link lookup by token hash.
//
// The raw URL token is NEVER stored — only its SHA-256 hash. The same
// pattern as API keys, invite tokens, and refresh tokens. A DB leak
// cannot recover the tokens.
//
// The lookup uses `withSystem` (supa_system role) to bypass RLS — the
// public share route has no user context, and `share_links` RLS allows
// SELECT only for users with `file:share` permission. Safe because:
//   1. The lookup key (token_hash) is a 64-char hex string — not user-
//      controllable beyond matching/not-matching a row.
//   2. Only the link row is returned (no cross-workspace data).
//   3. The viewer never sees the row directly — `resolve()` inspects only
//      the fields needed for the deny/admit decision + presign.

import { withSystem, getSystemPool } from "@supa/db/pool";

export interface ShareLinkRow {
  id: string;
  fileId: string;
  passwordHash: string | null;
  perm: "view" | "download" | "edit";
  expiresAt: Date | null;
  maxViews: number | null;
  viewCount: number;
  allowedEmail: string | null;
  revokedAt: Date | null;
  // Joined from files (needed for presign + verify the file still exists).
  storageKey: string | null;
  fileName: string;
}

interface RawShareLink {
  id: string;
  file_id: string;
  password_hash: string | null;
  perm: "view" | "download" | "edit";
  expires_at: Date | null;
  max_views: number | null;
  view_count: number;
  allowed_email: string | null;
  revoked_at: Date | null;
  storage_key: string | null;
  file_name: string;
}

/**
 * Find a share link by its token hash (SHA-256 of the raw URL token).
 *
 * Returns null if no match. The caller (resolve) treats null the same as
 * revoked/expired — deny "not_found" (no oracle).
 *
 * Uses `withSystem` to bypass RLS — the public route has no user context.
 * The query is scoped to a single row by the unique token_hash, so no
 * cross-workspace data leaks.
 *
 * Also inner-joins `files` — if the file was deleted (CASCADE), the share
 * link row is also gone (CASCADE), so the join is always consistent.
 * But if `files.storage_key` is null (upload never confirmed), we treat
 * the link as not_found (the file isn't readable yet).
 */
export async function byTokenHash(tokenHash: string): Promise<ShareLinkRow | null> {
  return withSystem(getSystemPool(), async (tx) => {
    // Raw SQL — `tx` is a postgres-js Transaction (not a Drizzle db).
    // Column names are snake_case at the SQL level; we map to camelCase
    // for the typed ShareLinkRow.
    const rows = await tx`
      select sl.id, sl.file_id, sl.password_hash, sl.perm,
             sl.expires_at, sl.max_views, sl.view_count,
             sl.allowed_email, sl.revoked_at,
             f.storage_key, f.name as file_name
        from share_links sl
        inner join files f on f.id = sl.file_id
       where sl.token_hash = ${tokenHash}
       limit 1`;
    const row = (rows as unknown as RawShareLink[])[0];
    if (!row) return null;

    // Upload never confirmed — the file isn't readable. Treat as not_found.
    if (!row.storage_key) return null;

    return {
      id: row.id,
      fileId: row.file_id,
      passwordHash: row.password_hash,
      perm: row.perm,
      expiresAt: row.expires_at,
      maxViews: row.max_views,
      viewCount: row.view_count,
      allowedEmail: row.allowed_email,
      revokedAt: row.revoked_at,
      storageKey: row.storage_key,
      fileName: row.file_name,
    };
  });
}
