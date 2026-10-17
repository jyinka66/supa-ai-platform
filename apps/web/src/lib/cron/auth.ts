// Cron authentication — shared helper for all cron routes.
//
// C4 FIX: the old cron routes compared `Bearer ${process.env.CRON_SECRET}` with
// `!==` (timing-vulnerable) AND didn't check for undefined (if CRON_SECRET is
// unset, the comparison becomes `"Bearer undefined"` — an attacker sends
// `Authorization: Bearer undefined`).
//
// This helper:
//   1. Fails hard if CRON_SECRET is unset in production (no bypass).
//   2. Uses `timingSafeEqual` for constant-time comparison (no timing attack).
//   3. Returns true/false (the route handler returns 401 on false).

import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

/**
 * Verify the CRON_SECRET Bearer token. Returns true if valid, false otherwise.
 *
 * In production: returns false if CRON_SECRET is unset (no bypass via "Bearer undefined").
 * In non-production: allows a fallback "dev-cron-secret" with a warning.
 *
 * The comparison is constant-time (timingSafeEqual) — prevents timing attacks
 * that could progressively reveal the secret.
 */
export function verifyCronSecret(req: NextRequest): boolean {
  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return false;
  }

  const presented = auth.slice(7);

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      console.error("[security] CRON_SECRET not set in production — cron route blocked.");
      return false;
    }
    console.warn("[security] CRON_SECRET not set — using dev fallback. DO NOT use in production.");
    return constantTimeCompare(presented, "dev-cron-secret");
  }

  return constantTimeCompare(presented, secret);
}

/**
 * Constant-time string comparison. Returns true if the strings are equal.
 */
function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still do a comparison to avoid timing leak on length difference.
    timingSafeEqual(Buffer.from(a), Buffer.from(a));
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}
