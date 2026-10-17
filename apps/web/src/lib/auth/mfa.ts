import { createClient } from "@supabase/supabase-js";
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "@supa/db";
import { mfaRecoveryCodes } from "@supa/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { ApiError } from "@/lib/http/middleware";

const TOTP_STEP_SECONDS = 30;
const TOTP_WINDOW = 1;
const TOTP_DIGITS = 6;
const ISSUER = "Supa AI";
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const RECOVERY_CODE_COUNT = 10;
const ARGON2_OPTIONS = { type: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/** MFA_ENCRYPTION_KEY must be 32 UTF-8 bytes or base64 for exactly 32 bytes. */
function getMfaKey(): Buffer {
  const value = process.env.MFA_ENCRYPTION_KEY;
  if (!value) throw new ApiError("mfa_encryption_key_unavailable", 503);
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 32 && decoded.toString("base64").replace(/=+$/, "") === value.replace(/=+$/, "")) {
    return decoded;
  }
  const raw = Buffer.from(value, "utf8");
  if (raw.length === 32) return raw;
  throw new ApiError("mfa_encryption_key_invalid", 503);
}

function encryptSecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getMfaKey(), iv);
  const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

function decryptSecret(value: string): string {
  try {
    const [version, iv, tag, data, extra] = value.split(".");
    if (version !== "v1" || !iv || !tag || !data || extra !== undefined) throw new Error("invalid_secret");
    const decipher = createDecipheriv("aes-256-gcm", getMfaKey(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("mfa_verification_unavailable", 503);
  }
}

function base32Encode(bytes: Buffer): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(input: string): Buffer {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of input.replace(/=+$/, "").toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error("invalid_totp_secret");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  if (!out.length) throw new Error("invalid_totp_secret");
  return Buffer.from(out);
}

function createTotp(secret: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

function verifyTotpCode(code: string, secret: string): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const supplied = Buffer.from(code, "ascii");
  const counter = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
  for (let delta = -TOTP_WINDOW; delta <= TOTP_WINDOW; delta++) {
    const expected = Buffer.from(createTotp(secret, counter + delta), "ascii");
    if (expected.length === supplied.length && timingSafeEqual(expected, supplied)) return true;
  }
  return false;
}

function normalizeRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, "").toUpperCase();
}
function formatRecoveryCode(code: string): string {
  return code.match(/.{1,4}/g)?.join("-") ?? code;
}

/** Create an encrypted pending TOTP factor; a confirmed factor is never overwritten. */
export async function beginTotpEnrollment(userId: string, label?: string): Promise<{ secret: string; otpauthUrl: string }> {
  getMfaKey();
  const rows = await db.execute(sql`select confirmed_at as "confirmedAt" from product_mfa_factors where user_id = ${userId}::uuid limit 1`);
  const existing = rows[0] as { confirmedAt: Date | null } | undefined;
  if (existing?.confirmedAt) throw new ApiError("mfa_already_enabled", 409);

  const secret = base32Encode(randomBytes(20));
  const encrypted = encryptSecret(secret);
  if (existing) {
    const updated = await db.execute(sql`update product_mfa_factors
      set totp_secret_encrypted = ${encrypted}, updated_at = now()
      where user_id = ${userId}::uuid and confirmed_at is null returning user_id`);
    if (!updated.length) throw new ApiError("mfa_enrollment_conflict", 409);
  } else {
    const inserted = await db.execute(sql`insert into product_mfa_factors (user_id, totp_secret_encrypted)
      values (${userId}::uuid, ${encrypted}) on conflict (user_id) do nothing returning user_id`);
    if (!inserted.length) throw new ApiError("mfa_enrollment_conflict", 409);
  }

  const account = label?.trim().slice(0, 254) || userId;
  const encodedLabel = encodeURIComponent(`${ISSUER}:${account}`);
  const otpauthUrl = `otpauth://totp/${encodedLabel}?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=6&period=30`;
  return { secret, otpauthUrl };
}

/** Confirm enrollment, then issue ten single-use recovery codes exactly once. */
export async function confirmTotpEnrollment(userId: string, code: string): Promise<string[] | null> {
  const rows = await db.execute(sql`select totp_secret_encrypted as "totpSecretEncrypted",
    confirmed_at as "confirmedAt" from product_mfa_factors where user_id = ${userId}::uuid limit 1`);
  const factor = rows[0] as { totpSecretEncrypted: string; confirmedAt: Date | null } | undefined;
  if (!factor) throw new ApiError("mfa_enrollment_not_found", 404);
  if (factor.confirmedAt) throw new ApiError("mfa_already_enabled", 409);
  if (!verifyTotpCode(code, decryptSecret(factor.totpSecretEncrypted))) return null;

  const argon2 = await import("argon2");
  const rawCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => randomBytes(10).toString("hex").toUpperCase());
  const hashes: string[] = [];
  for (const raw of rawCodes) hashes.push(await argon2.hash(raw, ARGON2_OPTIONS));

  await db.transaction(async (tx) => {
    const activated = await tx.execute(sql`update product_mfa_factors
      set confirmed_at = now(), updated_at = now()
      where user_id = ${userId}::uuid and confirmed_at is null returning user_id`);
    if (!activated.length) throw new ApiError("mfa_enrollment_conflict", 409);

    await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId as any));
    await tx.insert(mfaRecoveryCodes).values(hashes.map((codeHash) => ({ userId: userId as any, codeHash })));
  });
  return rawCodes.map(formatRecoveryCode);
}

/** Verify TOTP or atomically consume a valid, single-use recovery code. */
export async function verifyTotp(userId: string, code: string): Promise<boolean> {
  const rows = await db.execute(sql`select totp_secret_encrypted as "totpSecretEncrypted",
    confirmed_at as "confirmedAt" from product_mfa_factors where user_id = ${userId}::uuid limit 1`);
  const factor = rows[0] as { totpSecretEncrypted: string; confirmedAt: Date | null } | undefined;
  if (!factor?.confirmedAt) return false;

  if (/^\\d{6}$/.test(code)) return verifyTotpCode(code, decryptSecret(factor.totpSecretEncrypted));
  const normalized = normalizeRecoveryCode(code);
  if (!/^[A-F0-9]{20}$/.test(normalized)) return false;

  const unused = await db.select({ id: mfaRecoveryCodes.id, codeHash: mfaRecoveryCodes.codeHash })
    .from(mfaRecoveryCodes)
    .where(and(eq(mfaRecoveryCodes.userId, userId as any), isNull(mfaRecoveryCodes.usedAt)));
  const argon2 = await import("argon2");
  for (const item of unused) {
    let matches = false;
    try { matches = await argon2.verify(item.codeHash, normalized); } catch { matches = false; }
    if (!matches) continue;
    const consumed = await db.update(mfaRecoveryCodes).set({ usedAt: new Date() })
      .where(and(eq(mfaRecoveryCodes.id, item.id), eq(mfaRecoveryCodes.userId, userId as any), isNull(mfaRecoveryCodes.usedAt)))
      .returning({ id: mfaRecoveryCodes.id });
    return consumed.length > 0;
  }
  return false;
}

/** Verify a valid Supabase session is at AAL2 and its auth_time is recent. */
export async function requireRecentAal2(userId: string, accessToken: string): Promise<void> {
  if (!accessToken || accessToken.length > 16_384) throw new ApiError("mfa_reauth_required", 403);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new ApiError("mfa_verification_unavailable", 503);

  const supabase = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const [{ data: userData, error: userError }, { data: assurance, error: assuranceError }] = await Promise.all([
    supabase.auth.getUser(accessToken),
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
  ]);
  if (userError || !userData.user || userData.user.id !== userId || assuranceError || assurance?.currentLevel !== "aal2") {
    throw new ApiError("mfa_reauth_required", 403, { reason: "aal2_required" });
  }

  try {
    const encoded = accessToken.split(".")[1];
    if (!encoded) throw new Error("invalid_jwt");
    const claims = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
      auth_time?: unknown; sub?: unknown; aal?: unknown;
    };
    const authTime = Number(claims.auth_time);
    const now = Date.now() / 1000;
    if (claims.sub !== userId || claims.aal !== "aal2" || !Number.isFinite(authTime) || now - authTime > 300 || authTime - now > 30) {
      throw new Error("recent_aal2_required");
    }
  } catch {
    throw new ApiError("mfa_reauth_required", 403, { reason: "recent_aal2_required" });
  }
}
