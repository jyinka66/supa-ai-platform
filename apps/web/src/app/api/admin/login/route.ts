import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { login, type LoginDenyReason } from "@/lib/admin/auth";
import { errorResponse, requestId, corsHeaders } from "@/lib/http/middleware";

/**
 * POST /api/admin/login
 *
 * Admin login — product auth + MFA step-up → create admin session + set cookie.
 *
 * SEPARATE from product login:
 *   - Different cookie (supa_admin, not supa_refresh).
 *   - Different session table (admin_sessions, not sessions).
 *   - Different token (argon2id, 8h hard cap, 30min idle).
 *   - Requires MFA (admin TOTP — stored in admin_users.mfa_secret, separate
 *     from product MFA).
 *   - IP-bound (no roaming).
 *
 * Flow (delegates to lib/admin/auth.ts login()):
 *   1. Validate body (email, password, totpCode).
 *   2. Authenticate via Supabase (verifies the product password).
 *   3. Call login(userId, totp, ip, ua) — the combined admin login service.
 *   4. Map the LoginResult to an HTTP response:
 *        - ok → 200 { admin, session_id, expires_at } + set supa_admin cookie.
 *        - invalid_credentials → 401 { error: "invalid_credentials" } (no oracle).
 *        - enroll_required → 403 { error: "enroll_required" } (distinguishable — must enroll).
 *        - locked_15m → 429 { error: "locked_15m", retry_after: 900 } (rate-limited).
 *        - mfa → 401 { error: "invalid_mfa" } (distinguishable — retry).
 *        - ip_not_allowed → 403 { error: "ip_not_allowed" } (distinguishable — contact ops).
 *   5. Set the supa_admin cookie on success (Path=/api/admin, SameSite=Strict).
 *
 * Uniform timing envelope: on invalid_credentials, perform a dummy argon2id
 * verify to match real latency (prevents "email not found" vs "wrong password"
 * timing distinction).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  totpCode: z.string().regex(/^\d{6}$/),
});

export async function POST(req: NextRequest) {
  const rid = requestId(req);
  try {
    const body = await req.json();
    const parsed = LoginBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_request", detail: parsed.error.message },
        { status: 400 },
      );
    }

    const { email, password, totpCode } = parsed.data;
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "0.0.0.0";
    const userAgent = req.headers.get("user-agent") ?? "unknown";

    // 1. Product auth (Supabase — verifies the argon2id password hash).
    const supabase = await supabaseServer();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    let userId: string | null = null;
    if (!error && data.user) {
      userId = data.user.id;
    } else {
      // Uniform timing envelope — dummy argon2id verify to match real latency.
      await dummyArgon2Verify(password);
    }

    // 2. Call the combined admin login service.
    const result = await login(userId, totpCode, ip, userAgent);

    // 3. Map the result to an HTTP response.
    if (!result.ok) {
      return mapDenial(result.reason, rid, req);
    }

    // 4. Success — set the supa_admin cookie.
    const secure = process.env.NODE_ENV === "production";
    const cookieParts = [
      `supa_admin=${result.token}`,
      "Path=/api/admin",
      "HttpOnly",
      secure ? "Secure" : "",
      "SameSite=Strict",
      `Max-Age=${8 * 60 * 60}`, // 8h (matches the session hard cap).
    ].filter(Boolean);
    const cookie = cookieParts.join("; ");

    const res = NextResponse.json(
      {
        admin: { id: result.adminId, role: result.role },
        session_id: result.sessionId,
        expires_at: result.expiresAt.toISOString(),
      },
      { status: 200 },
    );
    res.headers.set("Set-Cookie", cookie);
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/api/admin/login");
  }
}

/**
 * Map a LoginDenyReason to the appropriate HTTP response.
 *
 * Distinguishable denials (the admin needs to act on them):
 *   - enroll_required → 403 (must enroll MFA before logging in)
 *   - locked_15m → 429 (rate-limited — too many MFA failures)
 *   - mfa → 401 (wrong TOTP code — retry)
 *   - ip_not_allowed → 403 (IP not in allowlist — contact ops)
 *
 * Uniform denial (no oracle):
 *   - invalid_credentials → 401 (covers: unknown email, wrong password,
 *     not an admin, admin revoked). All collapse to the same body + latency.
 */
function mapDenial(
  reason: LoginDenyReason,
  rid: string,
  req: NextRequest,
): NextResponse {
  let status: number;
  let body: Record<string, unknown>;
  let headers: Record<string, string> = {};

  switch (reason) {
    case "invalid_credentials":
      // No oracle — uniform body for all credential failures.
      status = 401;
      body = { error: "invalid_credentials" };
      break;
    case "enroll_required":
      status = 403;
      body = { error: "enroll_required", message: "MFA enrollment required before admin login." };
      break;
    case "locked_15m":
      status = 429;
      body = { error: "locked_15m", message: "Too many MFA failures. Try again in 15 minutes." };
      headers["Retry-After"] = "900"; // 15min in seconds.
      break;
    case "mfa":
      status = 401;
      body = { error: "invalid_mfa", message: "Invalid MFA code." };
      break;
    case "ip_not_allowed":
      status = 403;
      body = { error: "ip_not_allowed", message: "IP not in allowlist." };
      break;
    default:
      status = 401;
      body = { error: "invalid_credentials" };
  }

  const res = NextResponse.json(body, { status });
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
    res.headers.set(k, v);
  }
  res.headers.set("X-Request-Id", rid);
  return res;
}

/** Dummy argon2id verify to add latency matching a real password check. */
async function dummyArgon2Verify(password: string): Promise<void> {
  try {
    const argon2 = await import("argon2");
    await argon2.verify(
      "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      password,
    );
  } catch {
    // Expected — the dummy hash is invalid. The latency is added.
  }
}
