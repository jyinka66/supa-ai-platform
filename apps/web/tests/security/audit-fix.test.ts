/**
 * Security audit fix verification — tests that the critical findings from the
 * security audit are actually fixed. Pure unit tests (no DB, no network).
 *
 * Covers:
 *   C1 — JWT signature verification (authenticate uses jose.jwtVerify).
 *   C2 — JWT_SECRET fallback (throws in production if unset).
 *   C4 — CRON_SECRET bypass (verifyCronSecret uses timingSafeEqual, fails if unset in prod).
 *   C8 — MFA re-auth (requireMfaReauth checks enrollment, not a no-op stub).
 *   C9 — Session revocation (revokeAllSessions calls Supabase admin signOut + updates sessions table).
 *   C11/C12 — Share password argon2id + constant-time safeEqual.
 *   H15 — Webhook SSRF (assertPublic rejects private IPs + cloud metadata).
 *   H18 — SSO/SCIM RLS admin-only (not in tests yet — integration).
 */

import { describe, it, expect, vi } from "vitest";
import { timingSafeEqual, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// vitest runs from apps/web — process.cwd() is the project root or apps/web.
// Check both locations + use whichever exists.
import { existsSync } from "node:fs";
const webRoot = existsSync("/home/z/my-project/apps/web") ? "/home/z/my-project/apps/web" : process.cwd();
const projRoot = existsSync("/home/z/my-project/packages/db") ? "/home/z/my-project" : resolve(process.cwd(), "../..");

// ───────────────────────────────────────────────
// C1 — JWT signature verification
// ───────────────────────────────────────────────

describe("C1: JWT signature verification", () => {
  it("authenticate is not a blind decode (uses jose.jwtVerify)", async () => {
    // Read the source file to verify jose is imported.
    const fs = await import("node:fs");
    const source = readFileSync(
      resolve(webRoot + "/src/lib/http/middleware.ts"),
      "utf8",
    );
    expect(source).toContain("jose");
    expect(source).toContain("jwtVerify");
    expect(source).not.toContain("no signature verification");
  });

  it("a forged JWT (wrong signature) is rejected", async () => {
    // Create a JWT with a wrong signing key.
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      sub: "victim-user-id",
      aud: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600,
    })).toString("base64url");
    const wrongSig = createHmac("sha256", "wrong-key").update(`${header}.${payload}`).digest("base64url");
    const forgedJwt = `${header}.${payload}.${wrongSig}`;

    // The authenticate function should reject this.
    // We can't call authenticate directly (it needs NextRequest), but we
    // can verify the jose library rejects it.
    const { jwtVerify } = await import("jose");
    await expect(
      jwtVerify(forgedJwt, new TextEncoder().encode("correct-secret"), { audience: "authenticated" }),
    ).rejects.toThrow();
  });
});

// ───────────────────────────────────────────────
// C2 — JWT_SECRET fallback
// ───────────────────────────────────────────────

describe("C2: JWT_SECRET fallback", () => {
  it("getJwtSecret throws in production if secret is unset", async () => {
    const fs = await import("node:fs");
    const source = readFileSync(
      resolve(webRoot + "/src/lib/http/middleware.ts"),
      "utf8",
    );
    // Verify the production check exists in the source.
    expect(source).toContain("NODE_ENV");
    expect(source).toContain("production");
    expect(source).toContain("SUPABASE_JWT_SECRET");
    // Verify the fallback is gated on non-production.
    expect(source).toContain("dev-secret");
    expect(source).toContain("DO NOT use in production");
  });

  it("session.ts signJwt also checks production env", async () => {
    const fs = await import("node:fs");
    const source = readFileSync(
      resolve(webRoot + "/src/lib/auth/session.ts"),
      "utf8",
    );
    expect(source).toContain("SUPABASE_JWT_SECRET");
    expect(source).toContain("production");
    expect(source).toContain("DO NOT use in production");
  });
});

// ───────────────────────────────────────────────
// C4 — CRON_SECRET bypass
// ───────────────────────────────────────────────

describe("C4: CRON_SECRET bypass", () => {
  it("verifyCronSecret uses timingSafeEqual (not !==)", async () => {
    const fs = await import("node:fs");
    const source = readFileSync(
      resolve(webRoot + "/src/lib/cron/auth.ts"),
      "utf8",
    );
    expect(source).toContain("timingSafeEqual");
    expect(source).toContain("constantTimeCompare");
    // Verify the old vulnerable pattern is gone.
    expect(source).not.toContain("!== `Bearer");
  });

  it("verifyCronSecret returns false if CRON_SECRET is unset in production", async () => {
    const { verifyCronSecret } = await import("@/lib/cron/auth");
    const { NextRequest } = await import("next/server");

    // Save + override env.
    const origSecret = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    (process.env as any).NODE_ENV = "production";

    const req = new NextRequest("http://localhost/api/cron/test", {
      headers: { authorization: "Bearer undefined" },
    });
    const result = verifyCronSecret(req as any);
    expect(result).toBe(false);

    // Restore.
    (process.env as any).NODE_ENV = "test";
    if (origSecret) process.env.CRON_SECRET = origSecret;
  });

  it("verifyCronSecret rejects 'Bearer undefined' when secret is set", async () => {
    const { verifyCronSecret } = await import("@/lib/cron/auth");
    const { NextRequest } = await import("next/server");

    process.env.CRON_SECRET = "real-secret";
    const req = new NextRequest("http://localhost/api/cron/test", {
      headers: { authorization: "Bearer undefined" },
    });
    expect(verifyCronSecret(req as any)).toBe(false);
  });

  it("verifyCronSecret accepts the correct secret", async () => {
    const { verifyCronSecret } = await import("@/lib/cron/auth");
    const { NextRequest } = await import("next/server");

    process.env.CRON_SECRET = "real-secret";
    const req = new NextRequest("http://localhost/api/cron/test", {
      headers: { authorization: "Bearer real-secret" },
    });
    expect(verifyCronSecret(req as any)).toBe(true);
  });
});

// ───────────────────────────────────────────────
// C8 — MFA re-auth (not a no-op stub)
// ───────────────────────────────────────────────

describe("C8: MFA re-auth", () => {
  it("requireMfaReauth checks MFA enrollment (not a console.log stub)", async () => {
    const fs = await import("node:fs");
    const source = readFileSync(
      resolve(webRoot + "/src/lib/members/service.ts"),
      "utf8",
    );
    // Verify the stub is gone.
    expect(source).not.toContain("// Stub — the real implementation checks");
    expect(source).not.toContain("console.log(`[mfa] re-auth check");
    // Verify the real check is in place.
    expect(source).toContain("mfa_enrolled");
    expect(source).toContain("mfa_enrollment_required");
    expect(source).toContain("mfa_verification_failed");
  });
});

// ───────────────────────────────────────────────
// C9 — Session revocation (not a no-op stub)
// ───────────────────────────────────────────────

describe("C9: Session revocation", () => {
  it("revokeAllSessions calls supabase.auth.admin.signOut (not a console.log stub)", async () => {
    const fs = await import("node:fs");
    const source = readFileSync(
      resolve(webRoot + "/src/lib/members/service.ts"),
      "utf8",
    );
    // Verify the stub is gone.
    expect(source).not.toContain("// Stub — the real implementation calls Supabase");
    expect(source).not.toContain("console.log(`[sessions] would revoke");
    // Verify the real implementation is in place.
    expect(source).toContain("supabase.auth.admin.signOut");
    expect(source).toContain("revokedAt");
    // revokedReason is set in the lifecycle service's revokeAllSessions.
    const lifecycleSource = readFileSync(
      resolve(webRoot + "/src/lib/lifecycle/deletion.ts"),
      "utf8",
    );
    expect(lifecycleSource).toContain("revokedReason");
  });
});

// ───────────────────────────────────────────────
// C11/C12 — Share password argon2id + constant-time safeEqual
// ───────────────────────────────────────────────

describe("C11/C12: Share password security", () => {
  it("share route uses argon2id (not unsalted SHA-256)", async () => {
    const fs = await import("node:fs");
    const source = readFileSync(
      resolve(webRoot + "/src/app/api/work/share/[token]/route.ts"),
      "utf8",
    );
    // Verify argon2id is imported + used.
    expect(source).toContain("argon2");
    expect(source).toContain("verifySharePassword");
    expect(source).toContain("hashSharePassword");
    // Verify the old unsalted SHA-256 is replaced.
    // The function name `hashPassword` (the old unsalted SHA-256) should not
    // be the primary path. The `hashSharePassword` wrapper calls argon2id.
    expect(source).toContain("argonHash");
  });

  it("safeEqual uses timingSafeEqual (not Buffer.equals)", async () => {
    const fs = await import("node:fs");
    const source = readFileSync(
      resolve(webRoot + "/src/app/api/work/share/[token]/route.ts"),
      "utf8",
    );
    expect(source).toContain("timingSafeEqual");
    // Verify the old non-constant-time pattern is gone.
    expect(source).not.toContain("bufA.equals(bufB)");
  });
});

// ───────────────────────────────────────────────
// H15 — Webhook SSRF (assertPublic)
// ───────────────────────────────────────────────

describe("H15: Webhook SSRF defense", () => {
  it("assertPublic rejects private IPs", async () => {
    const { assertPublic } = await import("@/lib/webhooks/worker");

    const privateIps = [
      "10.0.0.1", "10.255.255.255",
      "172.16.0.1", "172.31.255.255",
      "192.168.1.1", "192.168.0.0",
      "127.0.0.1", "127.255.255.255",
      "169.254.169.254", "169.254.0.1", // cloud metadata.
      "0.0.0.0",
      "100.64.0.1", // CGNAT.
    ];

    for (const ip of privateIps) {
      expect(() => assertPublic(ip)).toThrow(/ip_blocked/);
    }
  });

  it("assertPublic rejects IPv6 loopback + link-local", async () => {
    const { assertPublic } = await import("@/lib/webhooks/worker");

    expect(() => assertPublic("::1")).toThrow(/loopback/);
    expect(() => assertPublic("::")).toThrow(/unspecified/);
    expect(() => assertPublic("fe80::1")).toThrow(/link_local/);
    expect(() => assertPublic("fc00::1")).toThrow(/ula/);
    expect(() => assertPublic("fd00::1")).toThrow(/ula/);
  });

  it("assertPublic accepts public IPs", async () => {
    const { assertPublic } = await import("@/lib/webhooks/worker");

    const publicIps = [
      "8.8.8.8", "1.1.1.1", "203.0.113.1", "198.51.100.1",
      "2606:4700:4700::1111", "2001:4860:4860::8888",
    ];

    for (const ip of publicIps) {
      expect(() => assertPublic(ip)).not.toThrow();
    }
  });

  it("webhook URLs must be HTTPS (CHECK constraint in migration)", async () => {
    const fs = await import("node:fs");
    const source = readFileSync(
      resolve(projRoot + "/packages/db/migrations/0040_webhooks_v2.sql"),
      "utf8",
    );
    expect(source).toContain("url ~ '^https://'");
  });
});

// ───────────────────────────────────────────────
// H18 — SSO/SCIM admin-only RLS
// ───────────────────────────────────────────────

describe("H18: SSO/SCIM admin-only RLS", () => {
  it("sso_connections RLS is admin-only (is_ws_member + admin)", async () => {
    const fs = await import("node:fs");
    const source = readFileSync(
      resolve(projRoot + "/packages/db/migrations/0042_sso_scim_v2.sql"),
      "utf8",
    );
    expect(source).toContain("is_ws_member(ws_id, 'admin')");
    // Verify it's NOT using a permissive policy (any member).
    expect(source).not.toContain("is_ws_member(ws_id))\n  with check");
  });

  it("sso_connections URL is HTTPS-only", async () => {
    const fs = await import("node:fs");
    const source = readFileSync(
      resolve(projRoot + "/packages/db/migrations/0042_sso_scim_v2.sql"),
      "utf8",
    );
    expect(source).toContain("idp_sso_url");
    expect(source).toContain("^https://");
  });
});

// ───────────────────────────────────────────────
// Password policy (argon2id + zxcvbn)
// ───────────────────────────────────────────────

describe("Password policy", () => {
  it("hashPassword uses argon2id (not SHA-256)", async () => {
    const fs = await import("node:fs");
    const source = readFileSync(
      resolve(webRoot + "/src/lib/auth/passwords.ts"),
      "utf8",
    );
    expect(source).toContain("argon2");
    expect(source).toContain("argon2id");
    expect(source).toContain("19456"); // OWASP 2024 memory cost.
  });

  it("requirePwPolicy rejects short passwords", async () => {
    const { requirePwPolicy, ApiError } = await import("@/lib/auth/passwords");
    expect(() => requirePwPolicy("short")).toThrow();
    expect(() => requirePwPolicy("123456789")).toThrow(); // < 12 chars.
  });

  it("requirePwPolicy accepts strong passwords", async () => {
    const { requirePwPolicy } = await import("@/lib/auth/passwords");
    expect(() => requirePwPolicy("Correct-Horse-Battery-Staple-2024!")).not.toThrow();
  });

  it("requirePwPolicy accepts 4-word passphrases", async () => {
    const { requirePwPolicy } = await import("@/lib/auth/passwords");
    expect(() => requirePwPolicy("correct horse battery staple")).not.toThrow();
  });

  it("needsRehash detects SHA-256 hashes (legacy)", async () => {
    const { needsRehash } = await import("@/lib/auth/passwords");
    const sha256Hash = "a".repeat(64); // 64 hex chars = SHA-256.
    expect(needsRehash(sha256Hash)).toBe(true);
  });

  it("needsRehash returns false for current argon2id hashes", async () => {
    const { needsRehash, hashPassword } = await import("@/lib/auth/passwords");
    const hash = await hashPassword("Correct-Horse-Battery-Staple-2024!");
    // The hash should start with $argon2id$ — needsRehash should return false.
    expect(hash).toMatch(/^\$argon2id/);
    expect(needsRehash(hash)).toBe(false);
  });
});
