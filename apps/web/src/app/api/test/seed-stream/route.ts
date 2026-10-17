import { NextRequest } from "next/server";
import { z } from "zod";
import { problem, ok } from "@/lib/api/problem";
import { testGate } from "@/lib/test/gate";
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
const STREAM_TTL_SECONDS = 300;

const Body = z.object({
  streamId: z.string().min(8).max(128),
  content: z.string().min(1).max(100_000),
});

/**
 * POST /api/test/seed-stream
 *
 * Seeds a stream buffer in Redis for testing the resume endpoint.
 * Writes the given content to `stream:<streamId>` so that
 * GET /api/chat/stream?streamId=<streamId> returns it.
 *
 * Test-only — returns 404 in production.
 *
 * Used by tests/integration/failover.test.ts → "resume endpoint returns
 * accumulated text after connection drop (HTTP)".
 */
export async function POST(req: NextRequest) {
  const gate = testGate(req);
  if (gate) return gate;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return problem(400, "invalid_json");
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return problem(400, "invalid_request", parsed.error.issues[0]?.message);
  }

  await redis.set(`stream:${parsed.data.streamId}`, parsed.data.content, {
    ex: STREAM_TTL_SECONDS,
  });

  return ok({ streamId: parsed.data.streamId, bytes: parsed.data.content.length });
}
