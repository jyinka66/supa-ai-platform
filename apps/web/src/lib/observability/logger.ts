import pinoFactory, { type Logger } from "pino";

/**
 * Structured log fields — the canonical shape for every log entry.
 *
 * The `requestId` is generated at the edge (middleware), propagated via the
 * `X-Request-Id` header, echoed to the client in responses, and stored on
 * `message_meta` so a support ticket ("my reply was slow at 3pm") resolves
 * to exact provider traces.
 *
 * NEVER log:
 *   - Message content (PII + can contain secrets users pasted)
 *   - API keys, tokens, bearer credentials
 *   - Email addresses (hash if needed for correlation)
 *   - Raw IP addresses (hash via `ip_hash` column in user_sessions)
 */
export interface LogFields {
  /** Edge-generated request ID — threads through every layer. */
  requestId?: string;
  userId?: string;
  route?: string;
  provider?: string;
  model?: string;
  promptVersion?: string;
  conversationId?: string;
  messageId?: string;
  latencyMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  error?: string;
  [k: string]: unknown;
}

type Level = "debug" | "info" | "warn" | "error";

const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug");

/**
 * Root Pino logger.
 *
 * Uses pino's built-in redaction for secrets (passwords, tokens, API keys)
 * + structured JSON output (single-line to stdout, cloud log drain handles
 * the rest).
 *
 * Use `.child({ ... })` to bind context (requestId, route, userId).
 *
 * @example
 *   const log = pino.child({ requestId, route: "auth" });
 *   log.info({ event: "signup_ok", user_id });
 */
export const pino: Logger = pinoFactory({
  level,
  redact: {
    paths: [
      "password",
      "*.password",
      "token",
      "*.token",
      "tokenHash",
      "*.tokenHash",
      "apiKey",
      "*.apiKey",
      "api_key",
      "*.api_key",
      "secret",
      "*.secret",
      "authorization",
      "*.authorization",
      "cookie",
      "*.cookie",
      "accessToken",
      "*.accessToken",
      "access_token",
      "*.access_token",
      "refreshToken",
      "*.refreshToken",
      "refresh_token",
      "*.refresh_token",
      "bearerToken",
      "*.bearerToken",
      "supabaseServiceRoleKey",
      "*.supabaseServiceRoleKey",
      "serviceRoleKey",
      "*.serviceRoleKey",
    ],
    censor: "[REDACTED]",
  },
  formatters: {
    level(label: string) {
      return { level: label };
    },
  },
  serializers: {
    err: pinoFactory.stdSerializers.err,
    req: pinoFactory.stdSerializers.req,
    res: pinoFactory.stdSerializers.res,
  },
});

/**
 * Creates a child logger bound to a request context.
 *
 * The `requestId` is the key field — it threads through middleware →
 * route handler → provider call → audit log → `message_meta.request_id`.
 *
 * @example
 *   // In a route handler:
 *   const log = makeLogger({ requestId: req.headers.get("x-trace-id")!, route: "chat/stream" });
 *   log.info("stream_started", { conversationId, userId });
 *   log.child({ provider: "gemini" }).info("provider_selected");
 */
export function makeLogger(base: LogFields) {
  const child = pino.child(base as Record<string, unknown>);

  const emit = (level: Level, msg: string, fields: LogFields = {}) => {
    child[level]({ msg, ...fields });
  };

  return {
    debug: (msg: string, f: LogFields = {}) => emit("debug", msg, f),
    info: (msg: string, f: LogFields = {}) => emit("info", msg, f),
    warn: (msg: string, f: LogFields = {}) => emit("warn", msg, f),
    error: (msg: string, f: LogFields = {}) => emit("error", msg, f),
    child: (extra: LogFields) => makeLogger({ ...base, ...extra }),
  };
}

export type RequestLogger = ReturnType<typeof makeLogger>;

/**
 * Extracts or generates a request ID from an incoming request.
 *
 * Priority:
 *   1. `X-Request-Id` header (if valid UUID — set by upstream proxy)
 *   2. `x-trace-id` header (our middleware's name for it)
 *   3. Generated UUID (fallback)
 *
 * The ID is echoed back in the response via `X-Request-Id` header so
 * clients can include it in support tickets.
 */
export function resolveRequestId(headers: Headers): string {
  const incoming =
    headers.get("x-request-id") ??
    headers.get("x-trace-id");
  if (incoming && /^[a-f0-9-]{36}$/i.test(incoming)) {
    return incoming;
  }
  return crypto.randomUUID();
}
