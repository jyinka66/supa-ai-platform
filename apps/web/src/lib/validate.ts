import { z } from "zod";
import { NextResponse } from "next/server";

/**
 * Max request body size — 32KB is generous for chat input.
 *
 * Rationale:
 *   - Average chat message: ~200 chars (~200 bytes)
 *   - Long-form document: ~10KB
 *   - Code paste: ~20KB
 *   - Anything larger should use a dedicated upload endpoint, not the JSON body
 *
 * This cap prevents memory-exhaustion DoS via huge JSON bodies.
 */
export const MAX_BODY_BYTES = 32 * 1024;

export type ParseBodyResult<T extends z.ZodType> =
  | { ok: true; data: z.infer<T> }
  | { ok: false; res: NextResponse };

/**
 * Parses + validates a request body against a Zod schema.
 *
 * Defense in depth:
 *   1. Content-Length header check (fast — rejects before reading the body)
 *   2. Actual body length check (in case Content-Length was spoofed/missing)
 *   3. JSON.parse with try/catch (malformed JSON → 400)
 *   4. Zod schema validation (semantic validation → 400 with field-level errors)
 *
 * Returns `{ ok: true, data }` if valid, or `{ ok: false, res }` with an
 * appropriate error response. The caller returns `res` directly:
 *
 *   const result = await parseBody(req, BodySchema);
 *   if (!result.ok) return result.res;
 *   const { content, conversationId } = result.data;
 *
 * Error responses include field-level validation details so the client can
 * highlight the specific field that failed (e.g. "content: too_long").
 */
export async function parseBody<T extends z.ZodTypeAny>(
  req: Request,
  schema: T,
): Promise<ParseBodyResult<T>> {
  // 1. Content-Length check (fast path — rejects before reading the body).
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY_BYTES) {
    return {
      ok: false,
      res: NextResponse.json(
        { error: "payload_too_large", maxBytes: MAX_BODY_BYTES },
        { status: 413 },
      ),
    };
  }

  // 2. Read the body (with a hard cap in case Content-Length was missing).
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return {
      ok: false,
      res: NextResponse.json({ error: "invalid_body" }, { status: 400 }),
    };
  }

  // 3. Actual length check (defends against missing/spoofed Content-Length).
  if (raw.length > MAX_BODY_BYTES) {
    return {
      ok: false,
      res: NextResponse.json(
        { error: "payload_too_large", maxBytes: MAX_BODY_BYTES },
        { status: 413 },
      ),
    };
  }

  // 4. JSON parse (malformed JSON → 400).
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      res: NextResponse.json(
        { error: "invalid_json" },
        { status: 400 },
      ),
    };
  }

  // 5. Zod validation (semantic errors → 400 with field details).
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      res: NextResponse.json(
        {
          error: "validation_failed",
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            code: i.code,
            message: i.message,
          })),
        },
        { status: 400 },
      ),
    };
  }

  return { ok: true, data: parsed.data };
}
