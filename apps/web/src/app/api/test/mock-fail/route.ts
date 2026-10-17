import { NextRequest } from "next/server";
import { z } from "zod";
import { problem, ok } from "@/lib/api/problem";
import { testGate } from "@/lib/test/gate";
import { setMockFail, clearMockFail, listMockFailProviders } from "@/lib/test/mock-fail-state";

const Body = z.object({
  provider: z.enum(["gemini", "groq", "openrouter"]),
  status: z.number().int().min(400).max(599).default(500),
  message: z.string().max(500).optional(),
  /** Number of calls before the mock auto-clears. Default: Infinity (never). */
  calls: z.number().int().min(1).max(10000).optional(),
});

/**
 * POST /api/test/mock-fail
 *
 * Forces a provider to fail on its next call. The provider adapter checks
 * `checkMockFail(provider)` at the top of its `stream()` method and throws
 * a synthetic error if the flag is set.
 *
 * Test-only — returns 404 in production.
 *
 * Body:
 *   { provider: "gemini", status: 500, message: "forced fail", calls: 5 }
 *
 * If `calls` is omitted, the mock persists until DELETE is called.
 * If `calls` is set, the mock auto-clears after N failures.
 *
 * Use the k6 failoverScenario to:
 *   1. POST /api/test/mock-fail { provider: "gemini", status: 500 }
 *   2. POST /api/chat/stream — should fail over to groq/openrouter
 *   3. DELETE /api/test/mock-fail { provider: "gemini" } — clear the mock
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

  setMockFail(parsed.data.provider, {
    status: parsed.data.status,
    message: parsed.data.message ?? `mock_fail: ${parsed.data.provider} → ${parsed.data.status}`,
    remainingCalls: parsed.data.calls,
  });

  return ok({
    provider: parsed.data.provider,
    status: parsed.data.status,
    calls: parsed.data.calls ?? "persistent",
  });
}

/**
 * DELETE /api/test/mock-fail
 *
 * Clears mock-fail state. If `provider` is in the body, clears only that
 * provider; otherwise clears all.
 */
export async function DELETE(req: NextRequest) {
  const gate = testGate(req);
  if (gate) return gate;

  let provider: string | undefined;
  try {
    const body = await req.json();
    provider = (body as { provider?: string })?.provider;
  } catch {
    // Empty body — clear all.
  }

  if (provider) {
    if (!["gemini", "groq", "openrouter"].includes(provider)) {
      return problem(400, "invalid_provider");
    }
    clearMockFail(provider as "gemini" | "groq" | "openrouter");
    return ok({ cleared: [provider] });
  }

  const cleared = listMockFailProviders();
  clearMockFail();
  return ok({ cleared });
}

/**
 * GET /api/test/mock-fail
 *
 * Returns the current mock-fail state (which providers are mocked).
 * Useful for debugging load test runs.
 */
export async function GET(req: NextRequest) {
  const gate = testGate(req);
  if (gate) return gate;

  return ok({
    mocked: listMockFailProviders(),
  });
}
