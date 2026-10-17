// Admin MFA (TOTP) — separate from product MFA.
//
// The spec: "Separate app, separate domain, separate auth — admin sessions
// share nothing with product sessions." This extends to MFA: the admin TOTP
// secret is stored in `admin_users.mfa_secret` (KMS-encrypted), NOT in
// Supabase's `auth.users.user_metadata` (where product MFA lives). A product
// MFA compromise does NOT grant admin MFA — they're independent credentials.
//
// ── enroll(adminId) ──
//   Generates a TOTP secret (160-bit base32), KMS-encrypts it, stores it on
//   `admin_users.mfa_secret` (pending confirmation — mfa_enrolled is still
//   false until confirmMfa is called with a valid code). Returns the otpauth
//   URL + secret for QR display.
//
//   The secret is stored BEFORE confirmation so that confirmMfa can decrypt
//   + verify against it. If the admin never confirms, the secret is harmless
//   (mfa_enrolled is false → can't create a session). A cleanup cron could
//   reap unconfirmed invites, but it's not critical.
//
// ── confirmMfa(adminId, code) ──
//   Decrypts the stored secret, verifies the TOTP code (±1 window for clock
//   drift). On success: marks `mfa_enrolled=true` + (if accepting an invite)
//   sets `accepted_at`. Returns true. On failure: returns false (no oracle —
//   the caller can't tell whether the secret exists, the code is wrong, or
//   the admin is revoked).
//
// ── verify(adminId, code) ──
//   Used by the login route's MFA step-up. Decrypts the secret, verifies the
//   code. Returns true/false. This is the gate: product auth alone is NOT
//   enough to create an admin session — the TOTP code is required.

import { db } from "@supa/db";
import { adminUsers } from "@supa/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { randomBytes, timingSafeEqual, createHmac } from "node:crypto";

// ───────────────────────────────────────────────
// Constants (RFC 6238)
// ───────────────────────────────────────────────

const TOTP_STEP = 30; // seconds.
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1; // ±1 time step (accepts previous/current/next 30s window).
const ISSUER = "SupaAdmin";

// ───────────────────────────────────────────────
// Base32 (RFC 4648) — A-Z + 2-7
// ───────────────────────────────────────────────

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buffer: Buffer): string {
  let result = "";
  let bits = 0;
  let value = 0;
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    result += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return result;
}

function base32Decode(encoded: string): Buffer {
  const cleaned = encoded.replace(/=+$/, "").toUpperCase();
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ───────────────────────────────────────────────
// TOTP (RFC 6238) — HMAC-SHA1
// ───────────────────────────────────────────────

function generateTotpSecret(): string {
  return base32Encode(randomBytes(20)); // 160 bits → 32 base32 chars.
}

function generateTotpCode(secret: string, counter?: number): string {
  const key = base32Decode(secret);
  const timeStep = counter ?? Math.floor(Date.now() / 1000 / TOTP_STEP);
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64BE(BigInt(timeStep));

  const hmacResult = createHmac("sha1", key).update(buffer).digest();
  const offset = (hmacResult[hmacResult.length - 1] ?? 0) & 0x0f;
  const code =
    (((hmacResult[offset] ?? 0) & 0x7f) << 24) |
    (((hmacResult[offset + 1] ?? 0) & 0xff) << 16) |
    (((hmacResult[offset + 2] ?? 0) & 0xff) << 8) |
    ((hmacResult[offset + 3] ?? 0) & 0xff);

  return String(code % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

function totpVerify(code: string, secret: string, window: number = TOTP_WINDOW): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const timeStep = Math.floor(Date.now() / 1000 / TOTP_STEP);
  for (let i = -window; i <= window; i++) {
    const expected = generateTotpCode(secret, timeStep + i);
    if (timingSafeEqual(Buffer.from(code), Buffer.from(expected))) {
      return true;
    }
  }
  return false;
}

// ───────────────────────────────────────────────
// KMS encryption (AES-256-GCM)
// ───────────────────────────────────────────────
// Same pattern as product MFA (auth/mfa.ts). In production: AWS KMS / Google
// KMS / Vault Transit. In dev: AES-256-GCM with a local key (KMS_KEY env).

async function kmsEncrypt(plaintext: string): Promise<string> {
  const key = process.env.KMS_KEY ?? "dev-kms-key-not-for-production";
  const keyBuf = Buffer.from(key.padEnd(32, "0").slice(0, 32));
  const { createCipheriv } = await import("node:crypto");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyBuf, iv);
  const encrypted = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

async function kmsDecrypt(ciphertext: string): Promise<string> {
  const key = process.env.KMS_KEY ?? "dev-kms-key-not-for-production";
  const keyBuf = Buffer.from(key.padEnd(32, "0").slice(0, 32));
  const { createDecipheriv } = await import("node:crypto");
  const data = Buffer.from(ciphertext, "base64");
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", keyBuf, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}

// ───────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────

export interface AdminEnrollmentResult {
  /** The otpauth URL for QR display (otpauth://totp/SupaAdmin:<email>?secret=...&issuer=SupaAdmin). */
  otpauthUrl: string;
  /** The base32 secret (for manual entry). */
  secret: string;
}

/**
 * Enroll admin MFA. Generates a TOTP secret, KMS-encrypts it, stores it on
 * `admin_users.mfa_secret` (mfa_enrolled stays false until confirmMfa).
 * Returns the otpauth URL + secret for QR display.
 *
 * @throws Error if the admin doesn't exist or is revoked.
 */
export async function enrollAdminMfa(adminId: string, email: string): Promise<AdminEnrollmentResult> {
  // Verify the admin exists + isn't revoked.
  const rows = await db
    .select({ userId: adminUsers.userId })
    .from(adminUsers)
    .where(and(eq(adminUsers.userId, adminId as any), isNull(adminUsers.revokedAt)))
    .limit(1);
  if (rows.length === 0) throw new Error("admin_not_found_or_revoked");

  const secret = generateTotpSecret();
  const encrypted = await kmsEncrypt(secret);

  await db
    .update(adminUsers)
    .set({ mfaSecret: encrypted })
    .where(eq(adminUsers.userId, adminId as any));

  const label = encodeURIComponent(`${ISSUER}:${email}`);
  const otpauthUrl = `otpauth://totp/${label}?secret=${secret}&issuer=${ISSUER}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP}`;

  return { otpauthUrl, secret };
}

/**
 * Confirm admin MFA enrollment. Verifies the TOTP code against the stored
 * (encrypted) secret. On success: marks `mfa_enrolled=true` + sets
 * `accepted_at` (if accepting an invite). Returns true. On failure: false.
 *
 * No oracle: the caller can't tell whether the secret exists, the code is
 * wrong, or the admin is revoked — all return false.
 */
export async function confirmAdminMfa(adminId: string, code: string): Promise<boolean> {
  const rows = await db
    .select({ mfaSecret: adminUsers.mfaSecret, revokedAt: adminUsers.revokedAt, acceptedAt: adminUsers.acceptedAt })
    .from(adminUsers)
    .where(eq(adminUsers.userId, adminId as any))
    .limit(1);
  const row = rows[0];
  if (!row || row.revokedAt || !row.mfaSecret) return false;

  let secret: string;
  try {
    secret = await kmsDecrypt(row.mfaSecret);
  } catch {
    return false;
  }

  if (!totpVerify(code, secret)) return false;

  // Mark enrolled + accept the invite (set accepted_at if not already).
  const updates: Record<string, unknown> = { mfaEnrolled: true };
  if (!row.acceptedAt) {
    updates.acceptedAt = new Date();
    updates.quarterlyReviewedAt = new Date();
  }
  await db
    .update(adminUsers)
    .set(updates)
    .where(eq(adminUsers.userId, adminId as any));

  return true;
}

/**
 * Verify a TOTP code for an admin (login step-up). Returns true if the code
 * is valid for the admin's enrolled secret.
 *
 * No oracle: false covers "admin not found", "revoked", "not enrolled",
 * "secret missing", "wrong code".
 */
export async function verifyAdminMfa(adminId: string, code: string): Promise<boolean> {
  const rows = await db
    .select({ mfaSecret: adminUsers.mfaSecret, mfaEnrolled: adminUsers.mfaEnrolled, revokedAt: adminUsers.revokedAt })
    .from(adminUsers)
    .where(eq(adminUsers.userId, adminId as any))
    .limit(1);
  const row = rows[0];
  if (!row || row.revokedAt || !row.mfaEnrolled || !row.mfaSecret) return false;

  let secret: string;
  try {
    secret = await kmsDecrypt(row.mfaSecret);
  } catch {
    return false;
  }

  return totpVerify(code, secret);
}

/**
 * Check if an admin has MFA enrolled (mfa_enrolled=true + not revoked).
 */
export async function isMfaEnrolled(adminId: string): Promise<boolean> {
  const rows = await db
    .select({ mfaEnrolled: adminUsers.mfaEnrolled, revokedAt: adminUsers.revokedAt })
    .from(adminUsers)
    .where(eq(adminUsers.userId, adminId as any))
    .limit(1);
  const row = rows[0];
  if (!row || row.revokedAt) return false;
  return row.mfaEnrolled;
}
