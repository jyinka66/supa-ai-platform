// HTTP middleware — the Phase 1 API surface middleware.
//
// Next.js-compatible (not Express — functional helpers that operate on
// NextRequest/NextResponse, not `(req, res, next)` chains).
//
//   requestId()    — injects a request id header (X-Request-Id) if not present.
//                    Used for tracing + the audit log's `instance` field.
//   authenticate() — Phase 1 JWT stub. Extracts the user id from the
//                    Authorization header (Supabase JWT). Phase 2 will add
//                    full session management (refresh token rotation, idle
//                    timeout, device fingerprinting).
//   billingGate()  — checks the workspace's billing state. Locked workspaces
//                    are read-only (writes → 402). Purged workspaces → 404.
//   jsonLimiter()  — rejects bodies larger than the limit (prevents abuse).
//   cors()         — CORS with an allowlist (no wildcard in production).
//
// Usage in Next.js App Router:
//   ```
//   export async function POST(req: NextRequest) {
//     const uid = await authenticate(req);  // throws 401 if not authenticated
//     const wsId = req.nextUrl.searchParams.get("wsId");
//     if (wsId) await billingGate(wsId, req.method);  // throws 402/404
//     // ... handler logic ...
//   }
//   ```

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

/** Simple ApiError with status code. */
export class ApiError extends Error {
  constructor(message: string, public status: number, public extra?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
  }
}

// ───────────────────────────────────────────────
// requestId — inject X-Request-Id if not present
// ───────────────────────────────────────────────

/**
 * Ensure the request has an `X-Request-Id` header. If not present, generates
 * one. Returns the request id (for logging + audit).
 *
 * The request id is used for:
 *   - Tracing (logs + metrics can correlate by request id).
 *   - The audit log's `instance` field (which request caused the audit event).
 *   - Error responses (the `instance` field in RFC 9457 Problem Details).
 */
export function requestId(req: NextRequest): string {
  const existing = req.headers.get("x-request-id");
  if (existing) return existing;
  const id = randomUUID();
  // Note: NextRequest headers are immutable — we can't set the header on the
  // incoming request. The caller should pass this id to the audit log + response.
  return id;
}

// ───────────────────────────────────────────────
// authenticate — JWT signature verification (C1 fix)
// ───────────────────────────────────────────────

import { jwtVerify, createRemoteJWKSet } from "jose";

/**
 * The Supabase JWKS URL for JWT verification. Supabase uses HS256 with the
 * JWT_SECRET (shared symmetric key) by default. For asymmetric (RS256),
 * the JWKS URL would be `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`.
 *
 * For the symmetric key path (the default), we verify against the JWT_SECRET
 * directly. For the asymmetric path, we'd use `createRemoteJWKSet`.
 *
 * C1 FIX: the old code decoded the JWT payload WITHOUT verifying the signature.
 * Any client could forge a JWT with arbitrary `sub` → impersonate any user.
 * Now we verify the signature using the JWT_SECRET (or JWKS if configured).
 */

// Cache the JWKS Set for asymmetric verification (if configured).
let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks() {
  if (_jwks) return _jwks;
  const jwksUrl = process.env.SUPABASE_JWKS_URL;
  if (jwksUrl) {
    _jwks = createRemoteJWKSet(new URL(jwksUrl));
  }
  return _jwks;
}

/**
 * Verify a JWT token + extract the user id.
 *
 * Two verification paths:
 *   1. Symmetric (HS256): verify against `SUPABASE_JWT_SECRET` (the default
 *      Supabase path — the JWT_SECRET env var is the HMAC key).
 *   2. Asymmetric (RS256): verify against the JWKS at `SUPABASE_JWKS_URL`
 *      (for Supabase instances configured with asymmetric keys).
 *
 * C2 FIX: if `SUPABASE_JWT_SECRET` is unset in production, throw immediately
 * (no fallback to "dev-secret"). In non-production, allow the fallback for
 * local dev only.
 *
 * Returns the user id (uid). Throws ApiError(401) if:
 *   - No Bearer token.
 *   - Token is malformed (not 3 parts).
 *   - Signature verification fails (forged token).
 *   - Token is expired.
 *   - No `sub` claim.
 */
export async function authenticate(req: NextRequest): Promise<string> {
  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    throw new ApiError("unauthenticated", 401);
  }

  const token = auth.slice(7);
  if (!token || token.split(".").length !== 3) {
    throw new ApiError("invalid_token", 401);
  }

  try {
    let payload: { sub?: string; exp?: number };

    const jwks = getJwks();
    if (jwks) {
      // Asymmetric (RS256) — verify against JWKS.
      const { payload: verified } = await jwtVerify(token, jwks, {
        audience: "authenticated",
        // Supabase JWTs have `aud: "authenticated"`.
      });
      payload = verified as { sub?: string; exp?: number };
    } else {
      // Symmetric (HS256) — verify against JWT_SECRET.
      const secret = getJwtSecret();
      const secretKey = new TextEncoder().encode(secret);
      const { payload: verified } = await jwtVerify(token, secretKey, {
        audience: "authenticated",
      });
      payload = verified as { sub?: string; exp?: number };
    }

    const uid = payload.sub;
    if (!uid) {
      throw new ApiError("no_subject", 401);
    }
    // jose's jwtVerify already checks `exp` — no need to check manually.
    return uid;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    // jose throws JWSSignatureVerificationFailed, JWTExpired, etc.
    throw new ApiError("invalid_token", 401);
  }
}

/**
 * Get the JWT secret for HMAC verification.
 *
 * C2 FIX: in production, throw if `SUPABASE_JWT_SECRET` is unset (no fallback
 * to "dev-secret" — that was the CRITICAL bug allowing anyone to forge JWTs).
 * In non-production, allow the fallback for local dev convenience.
 */
function getJwtSecret(): string {
  const secret = process.env.SUPABASE_JWT_SECRET ?? process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "SUPABASE_JWT_SECRET (or JWT_SECRET) is required in production. " +
          "Set it in your environment — never commit it.",
      );
    }
    // Dev only — explicitly warn.
    console.warn("[security] JWT_SECRET not set — using dev fallback. DO NOT use in production.");
    return "dev-secret";
  }
  return secret;
}

// ───────────────────────────────────────────────
// billingGate — locked workspaces are read-only, purged are 404
// ───────────────────────────────────────────────

/**
 * Check the workspace's billing state. Throws:
 *   - 404 if the workspace is purged (deleted + past grace period).
 *   - 402 if the workspace is locked AND the request is a write (POST/PUT/PATCH/DELETE).
 *
 * Read methods (GET/HEAD/OPTIONS) are allowed on locked workspaces (the user
 * can view + export their data during the lockout).
 *
 * The `billingState` is fetched from the `workspaces.billing_state` column
 * (migration 0031). The states are: active, grace, locked, canceled.
 * "purged" is when `deleted_at` is set + `purge_at` has passed (the workspace
 * is scheduled for hard purge — treat as 404).
 */
export async function billingGate(
  wsId: string,
  method: string,
): Promise<void> {
  const { getBillingState } = await import("@/lib/billing/gate");
  const state = await getBillingState(wsId);

  // Purged: the workspace is deleted + past grace → 404 (no existence leak).
  // (The actual hard purge happens via the nightly cron; between deletion and
  // purge, the workspace is soft-deleted but still accessible. After purge,
  // the row is gone → getBillingState would throw 404 → we return 404.)
  if (state.billingState === "canceled") {
    // Canceled = the workspace's subscription was canceled + the grace/lock
    // period has elapsed → treat as purged.
    throw new ApiError("not_found", 404);
  }

  // Locked: read-only. Write methods → 402.
  if (state.billingState === "locked" && !isReadMethod(method)) {
    throw new ApiError("billing_locked", 402, {
      billingState: state.billingState,
      downgradeAt: state.downgradeAt?.toISOString(),
    });
  }

  // Grace: features stay ON (the user gets a chance to fix the card).
  // Active: normal operation.
}

/** Check if the HTTP method is a read method (GET/HEAD/OPTIONS). */
function isReadMethod(method: string): boolean {
  return ["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

// ───────────────────────────────────────────────
// jsonLimiter — reject bodies larger than the limit
// ───────────────────────────────────────────────

/**
 * Check if the request body is within the size limit. Throws ApiError(413)
 * if the Content-Length exceeds the limit.
 *
 * Called before parsing the body (avoids buffering a huge body in memory).
 */
export function jsonLimiter(req: NextRequest, limitBytes: number = 1024 * 1024): void {
  const contentLength = req.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > limitBytes) {
    throw new ApiError("payload_too_large", 413, {
      limit: limitBytes,
      received: parseInt(contentLength, 10),
    });
  }
}

// ───────────────────────────────────────────────
// cors — CORS with an allowlist (no wildcard in production)
// ───────────────────────────────────────────────

const DEFAULT_CORS_ALLOWLIST = [
  process.env.APP_URL,
  process.env.APP_URL_STAGING,
  "http://localhost:3000", // dev.
].filter(Boolean) as string[];

/**
 * Build CORS headers for the response. Uses an allowlist (no wildcard in
 * production — the API is not publicly accessible from any origin).
 *
 * Returns the headers to set on the NextResponse.
 */
export function corsHeaders(origin: string | null): Record<string, string> {
  const allowlist = DEFAULT_CORS_ALLOWLIST;
  if (!origin || !allowlist.includes(origin)) {
    return {}; // No CORS headers — the request is blocked by the browser.
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Request-Id",
    "Access-Control-Max-Age": "86400",
  };
}

// ───────────────────────────────────────────────
// errorResponse — RFC 9457 Problem Details
// ───────────────────────────────────────────────

/**
 * Convert an error to a NextResponse with RFC 9457 Problem Details.
 * `ApiError` → the error's status + message. Unknown → 500.
 */
export function errorResponse(err: unknown, instance: string): NextResponse {
  if (err instanceof ApiError) {
    return NextResponse.json(
      {
        type: `https://api.example.com/errors/${err.message.toLowerCase()}`,
        title: err.message,
        status: err.status,
        detail: err.extra ? JSON.stringify(err.extra) : err.message,
        instance,
      },
      { status: err.status },
    );
  }
  console.error("[http] unhandled error:", err);
  return NextResponse.json(
    {
      type: "https://api.example.com/errors/internal",
      title: "Internal Server Error",
      status: 500,
      detail: err instanceof Error ? err.message : "Unknown error",
      instance,
    },
    { status: 500 },
  );
}
