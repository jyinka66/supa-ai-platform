import type { NextRequest } from "next/server";

/**
 * Trusted client IP — only honors x-forwarded-for if it came through
 * our trusted proxy. Takes the first IP and validates its shape.
 *
 * Falls back to "0.0.0.0" if the header is missing or malformed.
 * The fallback is intentional — rate limits then key against a single
 * "unknown" bucket, which is safer than letting attackers spoof IPs.
 */
export function ip(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (!xff) return "0.0.0.0";
  const first = xff.split(",")[0]?.trim() ?? "";
  // Validate IPv4 or IPv6 — reject anything else (e.g. SQL injection attempts).
  if (/^[a-f0-9.:]+$/i.test(first)) return first;
  return "0.0.0.0";
}
