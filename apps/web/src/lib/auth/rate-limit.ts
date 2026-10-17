import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { AUTH_CONFIG } from "./config";

const redis = Redis.fromEnv();

const limiters = Object.fromEntries(
  Object.entries(AUTH_CONFIG.rateLimits).map(([k, v]) => [
    k,
    new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(v.points, `${v.durationSec}s`),
      prefix: `auth:${k}`,
    }),
  ]),
) as Record<keyof typeof AUTH_CONFIG.rateLimits, Ratelimit>;

export async function checkRateLimit(
  kind: keyof typeof limiters,
  ip: string,
  email?: string,
): Promise<{ ok: boolean; retryAfter: number }> {
  const results = await Promise.all([
    limiters[kind].limit(`ip:${ip}`),
    email
      ? limiters[kind].limit(`email:${email.toLowerCase()}`)
      : Promise.resolve({ success: true, remaining: 0, reset: 0 }),
  ]);

  const blocked = results.some((r) => !r.success);
  if (blocked) {
    // Structured log; redact email to "present" only — never log email value.
    console.info(
      JSON.stringify({
        event: "auth_rate_limited",
        kind,
        ip,
        email: email ? "present" : "absent",
      }),
    );
  }

  // Upstash's `reset` is a Unix-ms timestamp. Convert to seconds-from-now.
  const retryAfter = Math.max(
    0,
    ...results.map((r) => (r.success ? 0 : Math.ceil((r.reset - Date.now()) / 1000))),
  );

  return { ok: !blocked, retryAfter };
}
