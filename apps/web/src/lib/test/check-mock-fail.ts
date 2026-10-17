import { getMockFail } from "@/lib/test/mock-fail-state";
import type { Provider } from "@/lib/router/router";

/**
 * Checks if the provider should fail per the test mock-fail state.
 * If so, throws a synthetic error matching the configured status code.
 *
 * Called at the top of every provider adapter's `stream()` method:
 *
 *   async *stream(req) {
 *     checkMockFail("gemini");
 *     const res = await fetch(...);
 *     ...
 *   }
 *
 * In production, the mock-fail endpoint is gated by NODE_ENV, so
 * `getMockFail()` always returns null and this function is a no-op.
 */
export function checkMockFail(provider: Provider): void {
  const config = getMockFail(provider);
  if (!config) return;

  const err = new Error(
    config.message ?? `mock_fail: ${provider} forced to ${config.status}`,
  ) as Error & { status?: number; provider?: Provider };
  err.status = config.status;
  err.provider = provider;
  throw err;
}
