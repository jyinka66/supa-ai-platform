// Share view recording + failed-view counting.
//
// Both operations go through SECURITY DEFINER functions (migration 0045)
// because the public share route has no user context — RLS on share_views
// denies INSERT and SELECT for anonymous viewers.
//
// record_share_view(share_id, ip_hash, ok):
//   - ok=true  → atomically increments view_count (race-safe) + inserts row.
//                Returns false if the link became invalid concurrently
//                (revoked/expired/exhausted between read + write) → caller
//                must deny "not_found".
//   - ok=false → inserts the row only (failed password attempt).
//
// count_failed_views(share_id, minutes):
//   - Counts ok=false rows in the last N minutes.
//   - Used by the password rate-limit (> 10 failures / 15 min → rate_limited).
//
// The ip_hash is a truncated SHA-256 (16 hex chars = 64 bits) — enough to
// group views by IP for analytics + rate-limit, not enough to recover the
// original IP. Retention: 90 days (nightly sweeper purges older rows).

import { db } from "@supa/db";
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";

/** Truncate the IP hash to 16 hex chars (64 bits). Sufficient for grouping,
 * insufficient to recover the original IP via rainbow tables. */
export function hashIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

/**
 * Record a view attempt. Returns whether the view was admitted.
 *
 * - ok=true:  returns true if the atomic increment succeeded (link still
 *             valid), false if the link became invalid concurrently.
 * - ok=false: always returns true (failed views are always recorded).
 *
 * The atomic increment is the quota gate: the WHERE clause
 * (revoked_at IS NULL AND not expired AND view_count < max_views) is
 * re-evaluated at UPDATE time, so concurrent requests cannot both
 * increment past max_views.
 */
export async function recordView(
  shareId: string,
  ip: string,
  ok: boolean,
): Promise<boolean> {
  const ipHash = hashIp(ip);
  const rows = await db.execute(sql`
    select record_share_view(${shareId}::uuid, ${ipHash}, ${ok})
  `);
  const result = (rows as unknown as Array<{ record_share_view: boolean }>)[0];
  return result?.record_share_view ?? false;
}

/**
 * Count failed (ok=false) views in the last N minutes.
 * Used by the password rate-limit.
 */
export async function failedCount(shareId: string, withinMinutes: number): Promise<number> {
  const rows = await db.execute(sql`
    select count_failed_views(${shareId}::uuid, ${withinMinutes})
  `);
  const result = (rows as unknown as Array<{ count_failed_views: number }>)[0];
  return Number(result?.count_failed_views ?? 0);
}
