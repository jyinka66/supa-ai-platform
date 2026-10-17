import { NextRequest, NextResponse } from "next/server";
import { rateLimit } from "./sliding-window";
import { TIERS, type TierName } from "./config";
import { supabaseServer } from "@/lib/supabase/server";
import { ip } from "@/lib/utils/ip";

/**
 * Rate-limit guard — call at the top of every route handler.
 *
 * Returns `null` if the request is allowed (caller proceeds).
 * Returns a `NextResponse` with 429 if the limit is exceeded (caller returns it).
 *
 * Subject selection:
 *   - Authenticated user → `u:<userId>` (per-user limit)
 *   - Anonymous → `ip:<clientIp>` (per-IP limit, for pre-auth brute force)
 *
 * This dual-subject strategy means:
 *   - Logged-in users get their full quota regardless of IP
 *   - Anonymous attackers can't rotate users to bypass IP limits
 *   - Anonymous attackers CAN rotate IPs to bypass user limits (mitigated
 *     by the IP-based fallback for anonymous requests)
 *
 * @example
 *   export async function POST(req: NextRequest) {
 *     const blocked = await guard(req, "chat");
 *     if (blocked) return blocked;
 *     // ... proceed
 *   }
 */
export async function guard(
  req: NextRequest,
  tier: TierName,
): Promise<NextResponse | null> {
  // Try to get the authenticated user (without throwing — anonymous is OK).
  let subject: string;
  try {
    const supabase = await supabaseServer();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (session?.user?.id) {
      subject = `u:${session.user.id}`;
    } else {
      subject = `ip:${ip(req)}`;
    }
  } catch {
    // Auth check failed (e.g. Redis down) — fall back to IP.
    subject = `ip:${ip(req)}`;
  }

  const t = TIERS[tier];
  const result = await rateLimit(`tier:${tier}:${subject}`, t.limit, t.windowMs);

  if (!result.ok) {
    return NextResponse.json(
      {
        error: "rate_limited",
        retryAfterSec: result.retryAfterSec,
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(result.retryAfterSec),
          "X-RateLimit-Remaining": String(result.remaining),
          "X-RateLimit-Limit": String(t.limit),
        },
      },
    );
  }

  return null;
}

/**
 * Convenience: guard + requireUser in one call.
 *
 * Use this when the route ALWAYS requires auth (most mutating routes).
 * Returns either the user (proceed) or a response (return it).
 *
 * @example
 *   export async function POST(req: NextRequest) {
 *     const result = await guardWithUser(req, "chat");
 *     if ("response" in result) return result.response;
 *     const user = result.user;
 *     // ... proceed
 *   }
 */
export async function guardWithUser(
  req: NextRequest,
  tier: TierName,
): Promise<
  | { user: import("@supabase/supabase-js").User }
  | { response: NextResponse }
> {
  // Check rate limit first (by IP if anonymous, by user if authenticated).
  const blocked = await guard(req, tier);
  if (blocked) {
    return { response: blocked };
  }

  // Now require auth — throws if unauthenticated.
  const { requireUser } = await import("@/lib/auth/session");
  try {
    const user = await requireUser();
    return { user };
  } catch {
    // Auth failed — return 401.
    return {
      response: NextResponse.json({ error: "unauthenticated" }, { status: 401 }),
    };
  }
}

/**
 * Specialized guard for login routes — prevents lockout-via-spam attacks.
 *
 * Problem: a naive per-user limit (5/5min) lets an attacker lock out a
 * victim by spamming failed logins against their email. The victim then
 * can't log in for 5 minutes.
 *
 * Solution: apply TWO limits with different subjects:
 *   1. Per-IP: 20 attempts / 5 min — catches single-IP brute force
 *   2. Per-(IP, email) pair: 5 attempts / 5 min — catches targeted attacks
 *      without locking out the victim from OTHER IPs
 *
 * The victim can still log in from a different IP even while under attack.
 * The attacker is blocked by the per-(IP, email) limit.
 *
 * @example
 *   export async function POST(req: NextRequest) {
 *     const denied = await guardLogin(req, email);
 *     if (denied) return denied;
 *     // ... proceed with login
 *   }
 *
 * @param email  The email being attempted (will be SHA-256 hashed before
 *               use as a rate-limit key — we don't want to leak emails
 *               via Redis key names).
 */
export async function guardLogin(
  req: NextRequest,
  email: string,
): Promise<NextResponse | null> {
  const clientIp = ip(req);
  const emailHash = await sha256Short(email.toLowerCase());

  // Per-IP limit: 20/5min — generous enough for legitimate users on shared
  // IPs (offices, NAT) but tight enough to block brute force.
  const ipResult = await rateLimit(`login:ip:${clientIp}`, 20, 300_000);
  if (!ipResult.ok) {
    return NextResponse.json(
      { error: "rate_limited", retryAfterSec: ipResult.retryAfterSec },
      {
        status: 429,
        headers: {
          "Retry-After": String(ipResult.retryAfterSec),
          "X-RateLimit-Scope": "ip",
        },
      },
    );
  }

  // Per-(IP, email) pair limit: 5/5min — stops targeted attacks against
  // a specific account from a single IP.
  const pairResult = await rateLimit(
    `login:pair:${clientIp}:${emailHash}`,
    5,
    300_000,
  );
  if (!pairResult.ok) {
    return NextResponse.json(
      { error: "rate_limited", retryAfterSec: pairResult.retryAfterSec },
      {
        status: 429,
        headers: {
          "Retry-After": String(pairResult.retryAfterSec),
          "X-RateLimit-Scope": "ip-email",
        },
      },
    );
  }

  return null;
}

/**
 * SHA-256 hash, truncated to 16 hex chars (64 bits) — enough entropy for a
 * rate-limit key, short enough to keep Redis keys small.
 */
async function sha256Short(input: string): Promise<string> {
  const { sha256 } = await import("@/lib/auth/tokens");
  const full = await sha256(input);
  return full.slice(0, 16);
}
