// Password hashing + verification — argon2id (OWASP 2024 baseline).
//
//   hashPassword(pw)   — validates the password against the policy (min 12
//                        chars OR 4-word passphrase; zxcvbn score ≥ 3), then
//                        hashes with argon2id (19 MiB memory, time=2, p=1).
//   verifyPassword(pw) — verifies a password against an argon2id hash.
//                        Returns false on mismatch (never throws).
//   needsRehash(hash)  — checks if the hash was produced with outdated
//                        parameters (memoryCost < current). If so, the caller
//                        should rehash transparently on next successful login.
//   requirePwPolicy(pw) — validates the password against the policy. Throws
//                        ApiError(400) with a descriptive reason if rejected.
//
// OWASP 2024 baseline parameters:
//   type:        argon2id (data-independent + data-dependent, side-channel resistant).
//   memoryCost:  19456 KiB (19 MiB) — the minimum for acceptable resistance
//                against GPU attacks per OWASP 2024.
//   timeCost:    2 iterations.
//   parallelism: 1 thread (single-threaded hash — avoids DoS via parallelism
//                exhaustion on servers with many cores).
//
// Password policy:
//   - Minimum 12 characters OR a 4-word passphrase (space-separated, each ≥3 chars).
//   - zxcvbn score ≥ 3 (moderate strength — rejects "password123" etc.).
//   - No maximum length (passphrase support — argon2id handles long inputs).
//   - No composition rules (no "must contain uppercase + symbol" — NIST 800-63B
//     says composition rules hurt more than they help).
//
// Transparent rehashing:
//   On successful login, check `needsRehash(storedHash)`. If the hash was
//   produced with outdated params (e.g. memoryCost < 19456, or the old
//   scrypt fallback), rehash with the current params + update the stored hash.
//   This is the "rehash transparently" pattern — the user's password is
//   upgraded to the current security baseline without requiring a password reset.

import zxcvbn from "zxcvbn";

// Argon2 is loaded lazily inside hash/verify operations. Importing this module
// must not load the native binary for routes (such as Supabase signup) that only
// need password-policy validation.
const argon2id = 2 as const;

// ───────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────

/** OWASP 2024 baseline argon2id parameters. */
export const ARGON_OPTS = {
  type: argon2id,
  memoryCost: 19456, // 19 MiB — OWASP 2024 baseline.
  timeCost: 2, // 2 iterations.
  parallelism: 1, // single-threaded.
} as const;

/** Minimum password length (characters). */
const MIN_LENGTH = 12;

/** Minimum passphrase word count (space-separated). */
const MIN_PASSPHRASE_WORDS = 4;

/** Minimum word length in a passphrase. */
const MIN_WORD_LENGTH = 3;

/** Minimum zxcvbn score (0-4; 3 = moderate, 4 = strong). */
const MIN_ZXCVBN_SCORE = 3;

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

/** Simple ApiError with status code. */
export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export interface PwPolicyResult {
  ok: boolean;
  reason?: string;
  score: number;
  suggestions: string[];
}

// ───────────────────────────────────────────────
// Password policy validation
// ───────────────────────────────────────────────

/**
 * Validate a password against the policy:
 *   - Minimum 12 characters OR a 4-word passphrase (space-separated, each ≥3 chars).
 *   - zxcvbn score ≥ 3 (moderate strength).
 *   - No composition rules (NIST 800-63B — composition rules hurt more than they help).
 *
 * Throws ApiError(400) if the password fails the policy.
 */
export function requirePwPolicy(pw: string): void {
  const result = checkPwPolicy(pw);
  if (!result.ok) {
    throw new ApiError(result.reason ?? "password_policy_violation", 400);
  }
}

/**
 * Check a password against the policy (non-throwing version).
 * Returns `{ ok, reason?, score, suggestions }`.
 */
export function checkPwPolicy(pw: string): PwPolicyResult {
  // Check minimum length OR passphrase.
  const isPassphrase = isPassphraseFormat(pw);
  if (pw.length < MIN_LENGTH && !isPassphrase) {
    return {
      ok: false,
      reason: `password_too_short: min ${MIN_LENGTH} chars or ${MIN_PASSPHRASE_WORDS}-word passphrase`,
      score: 0,
      suggestions: ["Use at least 12 characters, or a 4-word passphrase."],
    };
  }

  // Check zxcvbn score.
  const z = zxcvbn(pw);
  if (z.score < MIN_ZXCVBN_SCORE) {
    return {
      ok: false,
      reason: `password_too_weak: zxcvbn score ${z.score} < ${MIN_ZXCVBN_SCORE}`,
      score: z.score,
      suggestions: z.feedback.suggestions ?? [],
    };
  }

  return {
    ok: true,
    score: z.score,
    suggestions: z.feedback.suggestions ?? [],
  };
}

/**
 * Check if the password is a passphrase format (4+ space-separated words,
 * each ≥3 chars). Passphrases bypass the minimum length requirement
 * (a 4-word passphrase like "correct horse battery staple" is strong
 * even though it's only 29 chars — the entropy is in the word count).
 */
function isPassphraseFormat(pw: string): boolean {
  const words = pw.split(/\s+/).filter((w) => w.length >= MIN_WORD_LENGTH);
  return words.length >= MIN_PASSPHRASE_WORDS;
}

// ───────────────────────────────────────────────
// Hashing
// ───────────────────────────────────────────────

/**
 * Hash a password with argon2id (OWASP 2024 baseline params).
 *
 * Validates the password against the policy first (throws ApiError(400)
 * if the password is too short or too weak).
 *
 * Returns the argon2id hash string (includes the salt + params — the hash
 * is self-describing, so `verify` + `needsRehash` can parse the params).
 */
export async function hashPassword(pw: string): Promise<string> {
  requirePwPolicy(pw);
  const { hash } = await import("argon2");
  return hash(pw, ARGON_OPTS);
}

/**
 * Verify a password against an argon2id hash.
 *
 * Returns `true` on match, `false` on mismatch. Never throws (argon2's
 * `verify` throws on malformed hashes — we catch + return false).
 *
 * Also handles the scrypt fallback hashes from the apikeys service (those
 * use a different format: `salt(16) + hash(64) = 80 bytes` as a Buffer).
 * For scrypt hashes, use the scrypt verify path directly (not here).
 */
export async function verifyPassword(pw: string, h: string): Promise<boolean> {
  try {
    const { verify } = await import("argon2");
    return await verify(h, pw);
  } catch {
    return false;
  }
}

// ───────────────────────────────────────────────
// Transparent rehashing
// ───────────────────────────────────────────────

/**
 * Check if a stored hash needs rehashing (was produced with outdated params).
 *
 * argon2 hashes are self-describing (the hash string includes the params:
 * `$argon2id$v=19$m=19456,p=1,t=2$<salt>$<hash>`). We parse the memoryCost
 * from the hash string + compare to the current ARGON_OPTS.memoryCost.
 *
 * If the hash was produced with a lower memoryCost (or a different algorithm
 * like scrypt), `needsRehash` returns true — the caller should rehash with
 * the current params on the next successful login.
 *
 * Usage in the login flow:
 *   ```
 *   if (await verifyPassword(presentedPw, storedHash)) {
 *     if (needsRehash(storedHash)) {
 *       const newHash = await hashPassword(presentedPw);
 *       await updateUserPassword(userId, newHash);
 *     }
 *     // Login successful.
 *   }
 *   ```
 */
export function needsRehash(h: string): boolean {
  // argon2 hash format: $argon2id$v=19$m=<memoryCost>,p=<parallelism>,t=<timeCost>$<salt>$<hash>
  // Note: the argon2 npm package uses m,p,t order (not m,t,p).
  const match = h.match(/\$argon2(id|2i|2d)\$v=\d+\$m=(\d+),p=(\d+),t=(\d+)/);
  if (!match) {
    // Not an argon2 hash (could be scrypt, bcrypt, or plaintext) → needs rehash.
    return true;
  }

  const hashType = match[1];
  const memoryCost = parseInt(match[2]!, 10);
  const parallelism = parseInt(match[3]!, 10);
  const timeCost = parseInt(match[4]!, 10);

  // Check if the type is argon2id (not argon2i or argon2d).
  if (hashType !== "id") {
    return true; // argon2i/argon2d → rehash to argon2id.
  }

  // Check if the params match the current OWASP baseline.
  if (memoryCost < ARGON_OPTS.memoryCost) {
    return true; // memoryCost below baseline → rehash.
  }
  if (timeCost < ARGON_OPTS.timeCost) {
    return true; // timeCost below baseline → rehash.
  }
  if (parallelism < ARGON_OPTS.parallelism) {
    return true; // parallelism below baseline → rehash.
  }

  return false; // Hash is current — no rehash needed.
}

// ───────────────────────────────────────────────
// Rehash on successful login (convenience)
// ───────────────────────────────────────────────

/**
 * Verify a password + rehash transparently if the stored hash has outdated params.
 *
 * Returns `{ valid, rehashed }`:
 *   - `valid: true` if the password matches (regardless of whether rehash happened).
 *   - `rehashed: true` if the hash was upgraded (the caller should store the new hash).
 *   - `newHash: string` if rehashed (the new argon2id hash to store).
 *
 * Usage:
 *   ```
 *   const result = await verifyAndMaybeRehash(presentedPw, storedHash);
 *   if (result.valid) {
 *     if (result.rehashed) {
 *       await updateUserPassword(userId, result.newHash!);
 *     }
 *     // Login successful.
 *   }
 *   ```
 */
export async function verifyAndMaybeRehash(
  pw: string,
  storedHash: string,
): Promise<{ valid: boolean; rehashed: boolean; newHash?: string }> {
  const valid = await verifyPassword(pw, storedHash);
  if (!valid) {
    return { valid: false, rehashed: false };
  }

  if (needsRehash(storedHash)) {
    // Rehash with current params. Note: we DON'T call requirePwPolicy here —
    // the user already knows this password (they just verified it), so we
    // rehash even if it wouldn't pass the current policy (backward compat).
    try {
      const { hash } = await import("argon2");
      const newHash = await hash(pw, ARGON_OPTS);
      return { valid: true, rehashed: true, newHash };
    } catch {
      // Rehash failed (shouldn't happen) — login still succeeds, just no upgrade.
      return { valid: true, rehashed: false };
    }
  }

  return { valid: true, rehashed: false };
}
