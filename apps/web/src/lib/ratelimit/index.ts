import { rateLimit, type RateResult } from "./sliding-window";
import { getTier, getTierForRoute, type TierName } from "./config";

/**
 * Convenience: applies the rate limit for a named tier.
 *
 * @example
 *   const rl = await applyLimit("chat", userId);
 *   if (!rl.ok) return problem(429, "rate_limited", undefined, {
 *     retryAfter: rl.retryAfterSec,
 *   });
 */
export async function applyLimit(
  tier: TierName | string,
  identifier: string,
): Promise<RateResult> {
  const config = getTier(tier);
  return rateLimit(`${tier}:${identifier}`, config.limit, config.windowMs);
}

/**
 * Convenience: applies the rate limit for a route path.
 * Uses `getTierForRoute()` to determine the tier, then calls `rateLimit()`.
 *
 * @example
 *   const rl = await applyLimitForRoute("/api/chat/stream", userId);
 *   if (!rl.ok) return problem(429, "rate_limited");
 */
export async function applyLimitForRoute(
  pathname: string,
  identifier: string,
): Promise<RateResult> {
  const tier = getTierForRoute(pathname);
  return applyLimit(tier, identifier);
}

export { rateLimit, checkTwoTierLimits, type RateResult } from "./sliding-window";
export { TIERS, getTier, getTierForRoute, type TierName } from "./config";
