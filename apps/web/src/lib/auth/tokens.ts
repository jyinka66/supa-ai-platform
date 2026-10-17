import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const SECRET = process.env.INVITE_TOKEN_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "dev-invite-token-secret";
if (!SECRET) {
  throw new Error("INVITE_TOKEN_SECRET (or SUPABASE_SERVICE_ROLE_KEY) is required");
}

/**
 * Generates a single-use invite token:
 *   <uuid>.<uuid>.<hmac>
 * The HMAC binds the token to the (workspaceId, email) pair so the recipient
 * can only accept the invite for the workspace+email it was issued for.
 *
 * Raw token is sent only via email; the database stores sha256(token).
 */
export function generateInviteToken(workspaceId: string, email: string): string {
  const nonceA = randomUUID();
  const nonceB = randomUUID();
  const hmac = signHmac(`${workspaceId}|${email}`);
  return `${nonceA}.${nonceB}.${hmac}`;
}

/**
 * HMAC-SHA256 of a payload, hex-encoded. 64 chars.
 */
export function signHmac(payload: string): string {
  return createHmac("sha256", SECRET).update(payload).digest("hex");
}

/**
 * Constant-time equality check — prevents timing attacks on token comparison.
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/**
 * Verifies that an invite token's HMAC matches the (workspaceId, email) pair.
 * Used in addition to the sha256 lookup — defense in depth.
 */
export function verifyInviteToken(
  token: string,
  workspaceId: string,
  email: string,
): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const expected = signHmac(`${workspaceId}|${email}`);
  return safeEqual(parts[2] ?? "", expected);
}

/**
 * SHA-256 of an arbitrary string, hex-encoded. Used for token hashing
 * before database storage — raw tokens are never persisted.
 */
export async function sha256(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
