import { NextResponse, type NextRequest } from "next/server";

/**
 * Standardized API error response.
 *
 * Shape:
 *   {
 *     "error": {
 *       "code": "QUOTA_EXCEEDED",
 *       "message": "Storage quota of 50GB reached.",
 *       "details": { "usedBytes": 53687091200, "limitBytes": 53687091200 },
 *       "requestId": "req_01HXY..."
 *     }
 *   }
 *
 * Design principles:
 *   - `code` is a SCREAMING_SNAKE_CASE enum — clients switch on this, never on `message`.
 *   - `message` is safe to show to end users (no SQL, no stack traces, no internal paths).
 *   - `details` is optional structured data (quota usage, validation fields, rate-limit info).
 *   - `requestId` threads through the whole stack — same ID in logs, OTEL spans, and audit trail.
 *
 * The OLD flat shape ({ error: "code", detail: "..." }) is still supported via
 * `problemFlat()` for backward compatibility, but new code should use `problem()`.
 */

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  requestId?: string;
}

export interface ApiErrorResponse {
  error: ApiError;
}

/**
 * Error codes — the closed set of codes the API can return.
 * Clients switch on `code` (never `message`).
 *
 * When adding a new code:
 *   1. Add it here
 *   2. Add the HTTP status mapping in `httpStatusForCode()`
 *   3. Add a client-side handler in the frontend error boundary
 */
export const ERROR_CODES = {
  // Auth (401)
  UNAUTHENTICATED: "UNAUTHENTICATED",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  SESSION_EXPIRED: "SESSION_EXPIRED",

  // Authorization (403)
  FORBIDDEN: "FORBIDDEN",
  INSUFFICIENT_ROLE: "INSUFFICIENT_ROLE",
  MFA_REQUIRED: "MFA_REQUIRED",

  // Not found (404)
  NOT_FOUND: "NOT_FOUND",
  CONVERSATION_NOT_FOUND: "CONVERSATION_NOT_FOUND",
  WORKSPACE_NOT_FOUND: "WORKSPACE_NOT_FOUND",
  ITEM_NOT_FOUND: "ITEM_NOT_FOUND",
  FOLDER_NOT_FOUND: "FOLDER_NOT_FOUND",
  SHARE_LINK_NOT_FOUND: "SHARE_LINK_NOT_FOUND",

  // Conflict (409)
  ALREADY_EXISTS: "ALREADY_EXISTS",
  SLUG_TAKEN: "SLUG_TAKEN",
  NAME_CONFLICT: "NAME_CONFLICT",
  DUPLICATE_IN_FLIGHT: "DUPLICATE_IN_FLIGHT",

  // Gone (410)
  EXPIRED: "EXPIRED",
  REVOKED: "REVOKED",
  INVITE_INVALID: "INVITE_INVALID",
  INVITE_CONSUMED: "INVITE_CONSUMED",
  LINK_INVALID: "LINK_INVALID",

  // Validation (400)
  VALIDATION_FAILED: "VALIDATION_FAILED",
  INVALID_JSON: "INVALID_JSON",
  INVALID_REQUEST: "INVALID_REQUEST",
  INVALID_PARAMS: "INVALID_PARAMS",
  INVALID_TOKEN: "INVALID_TOKEN",
  INVALID_EMAIL: "INVALID_EMAIL",
  WEAK_PASSWORD: "WEAK_PASSWORD",
  EMPTY_PATCH: "EMPTY_PATCH",
  MISSING_PARAMS: "MISSING_PARAMS",

  // Rate limiting (429)
  RATE_LIMITED: "RATE_LIMITED",
  CSRF_INVALID_ORIGIN: "CSRF_INVALID_ORIGIN",

  // Quota / billing (402)
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
  BUDGET_EXCEEDED: "BUDGET_EXCEEDED",
  SEATS_FULL: "SEATS_FULL",

  // Payload (413)
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",

  // Server (500-503)
  INTERNAL_ERROR: "INTERNAL_ERROR",
  ALL_PROVIDERS_FAILED: "ALL_PROVIDERS_FAILED",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  UPSTREAM_TIMEOUT: "UPSTREAM_TIMEOUT",

  // Conflict (409) — specific
  CYCLE_DETECTED: "CYCLE_DETECTED",
  CROSS_WORKSPACE: "CROSS_WORKSPACE",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * Maps an error code to its HTTP status.
 */
function httpStatusForCode(code: string): number {
  const statusMap: Record<string, number> = {
    // 401
    UNAUTHENTICATED: 401,
    INVALID_CREDENTIALS: 401,
    SESSION_EXPIRED: 401,
    // 402
    QUOTA_EXCEEDED: 402,
    BUDGET_EXCEEDED: 402,
    SEATS_FULL: 402,
    // 403
    FORBIDDEN: 403,
    INSUFFICIENT_ROLE: 403,
    MFA_REQUIRED: 403,
    CSRF_INVALID_ORIGIN: 403,
    // 404
    NOT_FOUND: 404,
    CONVERSATION_NOT_FOUND: 404,
    WORKSPACE_NOT_FOUND: 404,
    ITEM_NOT_FOUND: 404,
    FOLDER_NOT_FOUND: 404,
    SHARE_LINK_NOT_FOUND: 404,
    // 409
    ALREADY_EXISTS: 409,
    SLUG_TAKEN: 409,
    NAME_CONFLICT: 409,
    DUPLICATE_IN_FLIGHT: 409,
    CYCLE_DETECTED: 409,
    CROSS_WORKSPACE: 409,
    // 410
    EXPIRED: 410,
    REVOKED: 410,
    INVITE_INVALID: 410,
    INVITE_CONSUMED: 410,
    LINK_INVALID: 410,
    // 400 (validation)
    VALIDATION_FAILED: 400,
    INVALID_JSON: 400,
    INVALID_REQUEST: 400,
    INVALID_PARAMS: 400,
    INVALID_TOKEN: 400,
    INVALID_EMAIL: 400,
    WEAK_PASSWORD: 400,
    EMPTY_PATCH: 400,
    MISSING_PARAMS: 400,
    // 413
    PAYLOAD_TOO_LARGE: 413,
    // 429
    RATE_LIMITED: 429,
    // 500-503
    INTERNAL_ERROR: 500,
    ALL_PROVIDERS_FAILED: 503,
    SERVICE_UNAVAILABLE: 503,
    UPSTREAM_TIMEOUT: 504,
  };
  return statusMap[code] ?? 500;
}

/**
 * Default user-facing messages per code.
 * These are safe to show to end users — no internal details.
 */
const DEFAULT_MESSAGES: Record<string, string> = {
  UNAUTHENTICATED: "Please sign in to continue.",
  INVALID_CREDENTIALS: "Invalid email or password.",
  SESSION_EXPIRED: "Your session has expired. Please sign in again.",
  FORBIDDEN: "You don't have permission to do this.",
  INSUFFICIENT_ROLE: "This action requires admin or owner role.",
  MFA_REQUIRED: "Multi-factor authentication is required for this action.",
  NOT_FOUND: "The requested resource was not found.",
  ALREADY_EXISTS: "This resource already exists.",
  SLUG_TAKEN: "This URL slug is already in use.",
  NAME_CONFLICT: "A resource with this name already exists in this location.",
  DUPLICATE_IN_FLIGHT: "A request with this idempotency key is already being processed.",
  EXPIRED: "This resource has expired.",
  REVOKED: "This resource has been revoked.",
  INVITE_INVALID: "This invite is invalid or has expired.",
  INVITE_CONSUMED: "This invite has already been used.",
  LINK_INVALID: "This share link is invalid, expired, or has been revoked.",
  VALIDATION_FAILED: "The request failed validation.",
  INVALID_JSON: "The request body is not valid JSON.",
  INVALID_REQUEST: "The request was malformed.",
  INVALID_PARAMS: "Missing or invalid query parameters.",
  INVALID_TOKEN: "The provided token is invalid.",
  INVALID_EMAIL: "Please enter a valid email address.",
  WEAK_PASSWORD: "Password must be at least 12 characters.",
  EMPTY_PATCH: "No fields to update.",
  MISSING_PARAMS: "Required parameters are missing.",
  QUOTA_EXCEEDED: "Storage quota has been reached.",
  BUDGET_EXCEEDED: "You've reached your usage budget.",
  SEATS_FULL: "Your workspace is at its seat limit.",
  PAYLOAD_TOO_LARGE: "The request body exceeds the maximum size.",
  RATE_LIMITED: "Too many requests. Please try again later.",
  CSRF_INVALID_ORIGIN: "Request blocked: invalid origin.",
  INTERNAL_ERROR: "An internal error occurred. Please try again.",
  ALL_PROVIDERS_FAILED: "All AI providers are currently unavailable.",
  SERVICE_UNAVAILABLE: "The service is temporarily unavailable.",
  UPSTREAM_TIMEOUT: "The upstream service timed out.",
  CYCLE_DETECTED: "This operation would create a circular reference.",
  CROSS_WORKSPACE: "This operation cannot cross workspace boundaries.",
  CONVERSATION_NOT_FOUND: "Conversation not found.",
  WORKSPACE_NOT_FOUND: "Workspace not found.",
  ITEM_NOT_FOUND: "Work item not found.",
  FOLDER_NOT_FOUND: "Folder not found.",
  SHARE_LINK_NOT_FOUND: "Share link not found.",
};

export interface ProblemOptions {
  /** Override the default user-facing message. */
  message?: string;
  /** Structured details (quota usage, validation fields, etc.). */
  details?: Record<string, unknown>;
  /** Override the HTTP status (defaults to the code's standard status). */
  status?: number;
  /** Request ID for traceability (auto-extracted from req if not provided). */
  requestId?: string;
}

/**
 * Creates a standardized error response.
 *
 * @example
 *   // Simple:
 *   return problem(ERROR_CODES.NOT_FOUND);
 *   // → 404 { error: { code: "NOT_FOUND", message: "The requested resource was not found." } }
 *
 *   // With details:
 *   return problem(ERROR_CODES.QUOTA_EXCEEDED, {
 *     message: "Storage quota of 50GB reached.",
 *     details: { usedBytes: 53687091200, limitBytes: 53687091200 },
 *   });
 *   // → 402 { error: { code: "QUOTA_EXCEEDED", message: "...", details: {...} } }
 *
 *   // With request ID (auto-extracted from req):
 *   return problem(ERROR_CODES.RATE_LIMITED, { details: { retryAfterSec: 60 } });
 *   // → 429 { error: { code: "RATE_LIMITED", message: "...", details: {...}, requestId: "..." } }
 */
// Overload 1: problem(status: number, message: string)
//    — problem(500, "deletion_request_failed")
export function problem(status: number, message: string): NextResponse;
// Overload 2: problem(status: number, code: string, detail?: string)
//    — problem(400, "invalid_request", "field X is required")
//    — problem(429, "rate_limited", undefined)
export function problem(status: number, code: string, detail?: string): NextResponse;
// Overload 3: problem(status: number, code: string, detail?: string, details?: Record<string, unknown>)
//    — problem(402, "budget_exceeded", undefined, { reason: budget.reason })
//    — problem(429, "rate_limited", undefined, { retryAfter: rl.retryAfter })
export function problem(
  status: number,
  code: string,
  detail?: string,
  details?: Record<string, unknown>,
): NextResponse;
// Overload 4: problem(code: ErrorCode | string, opts?: ProblemOptions)
//    — problem(ERROR_CODES.RATE_LIMITED, { details: { retryAfterSec: 60 } })
//    — problem("INVALID_TOKEN")
export function problem(code: ErrorCode | string, opts?: ProblemOptions): NextResponse;
export function problem(
  codeOrStatus: ErrorCode | string | number,
  optsOrMessageOrCode?: ProblemOptions | string,
  detail?: string,
  details?: Record<string, unknown>,
): NextResponse {
  // Overload 1/2/3 path: first arg is a number (HTTP status)
  if (typeof codeOrStatus === "number") {
    const status = codeOrStatus;

    // Overload 1: problem(500, "message") — 2 args, second is a plain message
    if (typeof optsOrMessageOrCode === "string" && detail === undefined && details === undefined) {
      // Distinguish overload 1 from overload 2:
      // Overload 1: message is a human-readable sentence (e.g. "deletion_request_failed")
      // Overload 2: code is a snake_case error code (e.g. "invalid_request") + optional detail
      // We handle both the same way — the second arg is the code/message.
      return NextResponse.json(
        { error: { code: optsOrMessageOrCode, message: detail ?? optsOrMessageOrCode } } satisfies ApiErrorResponse,
        { status },
      );
    }

    // Overload 2/3: problem(status, code, detail?, details?)
    const code = typeof optsOrMessageOrCode === "string" ? optsOrMessageOrCode : String(status);
    const message = detail ?? code;
    const errorBody: ApiError = { code, message };
    if (details) {
      errorBody.details = details;
    }
    return NextResponse.json(
      { error: errorBody } satisfies ApiErrorResponse,
      { status },
    );
  }

  // Overload 4 path: (code: string, opts?: ProblemOptions)
  const code = codeOrStatus;
  const opts = typeof optsOrMessageOrCode === "object" && optsOrMessageOrCode !== null
    ? optsOrMessageOrCode
    : typeof optsOrMessageOrCode === "string"
      ? { message: optsOrMessageOrCode }
      : {};
  const status = opts.status ?? httpStatusForCode(code);
  const message = opts.message ?? DEFAULT_MESSAGES[code] ?? "An error occurred.";

  const errorBody: ApiError = {
    code,
    message,
  };

  if (opts.details) {
    errorBody.details = opts.details;
  }

  if (opts.requestId) {
    errorBody.requestId = opts.requestId;
  }

  const headers: Record<string, string> = {};
  if (code === ERROR_CODES.RATE_LIMITED && opts.details?.retryAfterSec) {
    headers["Retry-After"] = String(opts.details.retryAfterSec);
  }

  return NextResponse.json({ error: errorBody } satisfies ApiErrorResponse, { status, headers });
}

/**
 * Creates a problem response from a thrown error.
 * Extracts the request ID from the request automatically.
 *
 * @example
 *   try { ... } catch (err) {
 *     return problemFromError(err, req);
 *   }
 */
export function problemFromError(
  err: unknown,
  req?: NextRequest,
): NextResponse {
  // Extract request ID from headers or AsyncLocalStorage context.
  const requestId =
    req?.headers.get("x-request-id") ??
    req?.headers.get("x-trace-id") ??
    undefined;

  // If it's already an ApiError-like object, use its code.
  if (err instanceof Error) {
    const statusErr = err as Error & { status?: number; code?: string };
    if (statusErr.code && statusErr.code in ERROR_CODES) {
      return problem(statusErr.code, {
        message: err.message,
        requestId,
      });
    }
  }

  // Unknown error → 500 with generic message (no internal details leaked).
  return problem(ERROR_CODES.INTERNAL_ERROR, {
    requestId,
    message: "An internal error occurred. Please try again.",
  });
}

/**
 * Standard success response.
 * Wraps payloads so the client shape is predictable.
 *
 * @example
 *   return ok({ items: [...] });
 *   // → 200 { ok: true, data: { items: [...] } }
 */
export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ ok: true, data }, { status });
}

/**
 * Backward-compatible flat problem (old shape).
 * Kept for routes that haven't been migrated yet.
 *
 * @deprecated Use `problem()` instead.
 */
export function problemFlat(
  status: number,
  code: string,
  detail?: string,
  extra?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json(
    { error: code, ...(detail ? { detail } : {}), ...(extra ?? {}) },
    { status },
  );
}

/**
 * Custom error class for throwing in route handlers.
 * Caught by `problemFromError()` which converts it to a problem response.
 *
 * @example
 *   throw new ApiProblemError(ERROR_CODES.NOT_FOUND, "Conversation not found");
 */
export class ApiProblemError extends Error {
  code: ErrorCode;
  details?: Record<string, unknown>;

  constructor(code: ErrorCode, message?: string, details?: Record<string, unknown>) {
    super(message ?? DEFAULT_MESSAGES[code] ?? "An error occurred.");
    this.name = "ApiProblemError";
    this.code = code;
    this.details = details;
  }
}
