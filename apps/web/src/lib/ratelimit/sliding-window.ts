import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

/**
 * Sliding-window rate limiter using a Redis sorted set (ZSET).
 *
 * Each request adds a member to the ZSET with the current timestamp as its
 * score. Before adding, we prune entries older than `windowMs` and count
 * the remaining entries. If count >= limit, the request is denied.
 *
 * The entire operation is atomic — a single Lua `EVAL` does:
 *   1. ZREMRANGEBYSCORE (prune old entries)
 *   2. ZCARD (count current entries)
 *   3. If under limit: ZADD (add this request) + PEXPIRE (set TTL)
 *   4. Return {allowed, retryAfterSec, remaining}
 *
 * This avoids the check-then-act race condition that exists with separate
 * GET + SET calls.
 *
 * The ZSET key is scoped per (scope, window-bucket) so that different
 * scopes don't share counters. We DON'T bucket by time — the ZSET itself
 * IS the sliding window (pruning happens on every call).
 */

const SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

-- Prune entries older than the window.
redis.call('ZREMRANGEBYSCORE', key, 0, now - window_ms)

-- Count remaining entries.
local count = redis.call('ZCARD', key)

if count >= limit then
  -- Denied: compute retry-after from the oldest entry in the window.
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry_after = 0
  if oldest[2] ~= nil then
    retry_after = math.ceil((tonumber(oldest[2]) + window_ms - now) / 1000)
    if retry_after < 0 then retry_after = 0 end
  end
  return {0, retry_after, limit - count}
end

-- Allowed: add this request to the window.
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window_ms)

-- remaining = limit - count - 1 (this request just consumed one slot)
return {1, 0, limit - count - 1}
`;

export interface RateResult {
  /** True if the request is allowed. */
  ok: boolean;
  /** Remaining requests in the current window (after this one if allowed). */
  remaining: number;
  /** Seconds until the caller should retry (0 if allowed). */
  retryAfterSec: number;
}

/**
 * Checks the rate limit for a given scope.
 *
 * @param scope    Identifier for the rate-limit bucket (e.g. "chat:u_abc123",
 *                 "signup:ip_1.2.3.4"). Different scopes have independent
 *                 counters.
 * @param limit    Maximum requests allowed in the window.
 * @param windowMs Window size in milliseconds.
 *
 * @example
 *   const rl = await rateLimit("chat:u_abc123", 20, 60_000); // 20 req/min
 *   if (!rl.ok) return problem(429, "rate_limited", undefined, {
 *     retryAfter: rl.retryAfterSec,
 *   });
 */
export async function rateLimit(
  scope: string,
  limit: number,
  windowMs: number,
): Promise<RateResult> {
  const key = `rl:${scope}`;

  // Member must be unique per request — even if two requests arrive at the
  // same millisecond. We use a UUID suffix to guarantee uniqueness.
  // (ZADD with a duplicate member would just update the score, not add a
  // new entry — which would undercount.)
  const member = `${Date.now()}:${crypto.randomUUID()}`;

  const result = (await redis.eval(SCRIPT, [key], [
    String(Date.now()),
    String(windowMs),
    String(limit),
    member,
  ])) as number[];

  const allowed = result[0] ?? 0;
  const retryAfter = result[1] ?? 0;
  const remaining = result[2] ?? 0;

  return {
    ok: allowed === 1,
    remaining: Math.max(remaining, 0),
    retryAfterSec: Math.max(retryAfter, 0),
  };
}

/**
 * Convenience: applies the two-tier rate limiting strategy.
 *
 * Tier 1 (cost protection): strict limit on provider-calling routes.
 *   e.g. 20 chat messages per minute per user.
 *
 * Tier 2 (abuse protection): looser limit on all other routes.
 *   e.g. 100 API calls per minute per user.
 *
 * Returns the FIRST limit that's exceeded (so the caller can return the
 * most specific error). If both pass, returns `{ ok: true }`.
 */
export async function checkTwoTierLimits(
  userId: string,
  strict: { scope: string; limit: number; windowMs: number },
  loose: { scope: string; limit: number; windowMs: number },
): Promise<RateResult> {
  // Check strict first — if it fails, return immediately.
  const strictResult = await rateLimit(`strict:${strict.scope}:u_${userId}`, strict.limit, strict.windowMs);
  if (!strictResult.ok) {
    return { ...strictResult, remaining: 0 };
  }

  // Then check loose.
  const looseResult = await rateLimit(`loose:${loose.scope}:u_${userId}`, loose.limit, loose.windowMs);
  if (!looseResult.ok) {
    return looseResult;
  }

  // Both passed — return the stricter remaining count.
  return {
    ok: true,
    remaining: Math.min(strictResult.remaining, looseResult.remaining),
    retryAfterSec: 0,
  };
}
