import type { Provider } from "@/lib/router/router";

/**
 * In-memory mock-fail state for the provider adapters.
 *
 * When the load test calls POST /api/test/mock-fail, it sets a flag here.
 * The provider adapters check `shouldFail(provider)` before making the
 * real HTTP call and return a synthetic error if the flag is set.
 *
 * This is test-only — the gate at /api/test/mock-fail/route.ts ensures
 * the endpoint is not accessible in production, so the adapter code never
 * needs to be conditionally loaded.
 *
 * State is process-local (not Redis-backed) because:
 *   1. It's only needed for the failover load test, which runs against
 *      a single server instance.
 *   2. We don't want mock state to persist across server restarts.
 *   3. We don't want to pollute Redis with test data.
 */

interface MockFailConfig {
  /** HTTP status to return when the provider is called. */
  status: number;
  /** Optional error message. */
  message?: string;
  /** Number of calls before the mock clears itself (default: Infinity — never auto-clear). */
  remainingCalls?: number;
}

const state = new Map<Provider, MockFailConfig>();

export function setMockFail(provider: Provider, config: MockFailConfig): void {
  state.set(provider, config);
}

export function clearMockFail(provider?: Provider): void {
  if (provider) {
    state.delete(provider);
  } else {
    state.clear();
  }
}

/**
 * Returns the mock-fail config if the provider should fail, or null otherwise.
 * Decrements `remainingCalls` if set; when it hits 0, the mock auto-clears.
 */
export function getMockFail(provider: Provider): MockFailConfig | null {
  const config = state.get(provider);
  if (!config) return null;

  if (config.remainingCalls !== undefined) {
    config.remainingCalls -= 1;
    if (config.remainingCalls <= 0) {
      state.delete(provider);
    }
  }

  return config;
}

export function listMockFailProviders(): Provider[] {
  return Array.from(state.keys());
}
