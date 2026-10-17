/**
 * Per-provider health tracking for the model router.
 *
 * Tracks a sliding window of recent requests per provider so the router
 * can:
 *   - Skip providers whose circuit breaker is open
 *   - Deprioritise providers with elevated error rate or p95 latency
 *   - Recover via a half-open state (one probe request before full restore)
 *
 * Designed to be process-local — for multi-instance deployments you'll
 * want to back this with Redis so all instances agree on provider health.
 */

export interface HealthRecord {
  /** Timestamps of recent requests (successful or failed), within WINDOW. */
  events: number[];
  /** Timestamps of recent failures, within WINDOW. */
  failures: number[];
  /** Latency samples (first-token ms) for successful requests, within WINDOW. */
  latencies: number[];
  /** Epoch-ms timestamp until which the circuit is forced open. */
  circuitOpenUntil: number;
  /** True if the circuit is half-open (a probe is in flight). */
  halfOpen: boolean;
}

export interface HealthSnapshot {
  errorRate: number;
  p95FirstTokenMs: number | null;
  consecutiveFailures: number;
  circuitOpen: boolean;
  halfOpen: boolean;
}

const WINDOW_MS = 60_000;
const MAX_SAMPLES = 200;
const CIRCUIT_OPEN_DEFAULT_MS = 30_000;
const FAILURE_THRESHOLD = 5;

export class ProviderHealth {
  private records = new Map<string, HealthRecord>();

  /**
   * Records a single request outcome.
   *
   * @param provider       Provider key (e.g. "openai", "anthropic")
   * @param firstTokenMs   Time-to-first-token in ms, or null on error.
   * @param error          True if the request errored.
   */
  record(provider: string, firstTokenMs: number | null, error: boolean): void {
    const now = Date.now();
    const r = this.records.get(provider) ?? this.blank();

    // Drop samples older than WINDOW_MS.
    r.events = r.events.filter((t) => t > now - WINDOW_MS);
    r.failures = r.failures.filter((t) => t > now - WINDOW_MS);
    r.latencies = r.latencies.filter((t) => t > now - WINDOW_MS);

    r.events.push(now);
    if (error) {
      r.failures.push(now);

      // Auto-open the circuit if we've crossed the failure threshold.
      if (r.failures.length >= FAILURE_THRESHOLD && r.circuitOpenUntil < now) {
        r.circuitOpenUntil = now + CIRCUIT_OPEN_DEFAULT_MS;
        r.halfOpen = false;
      }
    } else {
      // Successful request — if we were half-open, restore the provider.
      if (r.halfOpen) {
        r.circuitOpenUntil = 0;
        r.halfOpen = false;
      }
      if (firstTokenMs !== null) {
        r.latencies.push(firstTokenMs);
        // Cap memory — keep the most recent MAX_SAMPLES samples.
        if (r.latencies.length > MAX_SAMPLES) {
          r.latencies = r.latencies.slice(-MAX_SAMPLES);
        }
      }
    }

    // Cap events array too — defensive against pathological call rates.
    if (r.events.length > MAX_SAMPLES) {
      r.events = r.events.slice(-MAX_SAMPLES);
    }

    this.records.set(provider, r);
  }

  /**
   * Force-opens the circuit for a provider. Creates a record if the
   * provider has never been seen before — useful for out-of-band signals
   * (e.g. an upstream status page flip).
   */
  openCircuit(provider: string, durationMs = CIRCUIT_OPEN_DEFAULT_MS): void {
    const r = this.records.get(provider) ?? this.blank();
    r.circuitOpenUntil = Date.now() + durationMs;
    r.halfOpen = false;
    this.records.set(provider, r);
  }

  /**
   * Returns true if the provider can accept traffic right now.
   *
   * A provider is healthy if:
   *   - The circuit is not forced open (circuitOpenUntil has passed)
   *   - We're not in a half-open probe (only one probe at a time)
   *   - Recent failure count is below the threshold
   *
   * Unknown providers are considered healthy (innocent until proven guilty).
   */
  isHealthy(provider: string): boolean {
    const r = this.records.get(provider);
    if (!r) return true;

    const now = Date.now();

    // Circuit hard-open — still in the cool-down period.
    if (r.circuitOpenUntil > now) return false;

    // Circuit was open, the cool-down has expired — transition to half-open.
    // The next request will be a probe; if it succeeds, the circuit closes.
    if (r.circuitOpenUntil !== 0 && !r.halfOpen) {
      r.halfOpen = true;
      // Note: we don't return false here — the probe is allowed through.
      // But we DON'T want a thundering herd of probes, so we mark it half-open
      // and only let one through. Subsequent isHealthy() calls during the same
      // probe window will return false (because halfOpen is true).
      return true;
    }

    // A probe is already in flight — block additional traffic.
    if (r.halfOpen) return false;

    // No circuit issues — check recent failure rate.
    return r.failures.length < FAILURE_THRESHOLD;
  }

  /**
   * Returns a full snapshot for observability / metrics endpoints.
   */
  snapshot(provider: string): HealthSnapshot {
    const r = this.records.get(provider);
    if (!r) {
      return {
        errorRate: 0,
        p95FirstTokenMs: null,
        consecutiveFailures: 0,
        circuitOpen: false,
        halfOpen: false,
      };
    }
    const now = Date.now();
    r.events = r.events.filter((t) => t > now - WINDOW_MS);
    r.failures = r.failures.filter((t) => t > now - WINDOW_MS);
    r.latencies = r.latencies.filter((t) => t > now - WINDOW_MS);

    const total = r.events.length;
    const errorRate = total > 0 ? r.failures.length / total : 0;
    const p95 = r.latencies.length > 0 ? percentile(r.latencies, 0.95) : null;
    const circuitOpen = r.circuitOpenUntil > now;

    return {
      errorRate,
      p95FirstTokenMs: p95,
      consecutiveFailures: r.failures.length,
      circuitOpen,
      halfOpen: r.halfOpen,
    };
  }

  /**
   * Drops providers that haven't seen activity in 2× WINDOW_MS.
   * Call periodically (e.g. every 60s) to prevent memory bloat from
   * providers that have been removed from rotation.
   */
  pruneStale(now = Date.now()): number {
    let pruned = 0;
    for (const [provider, r] of this.records) {
      const lastEvent = r.events[r.events.length - 1] ?? 0;
      if (lastEvent < now - WINDOW_MS * 2) {
        this.records.delete(provider);
        pruned++;
      }
    }
    return pruned;
  }

  /** Exposed for tests. */
  get knownProviders(): string[] {
    return Array.from(this.records.keys());
  }

  private blank(): HealthRecord {
    return {
      events: [],
      failures: [],
      latencies: [],
      circuitOpenUntil: 0,
      halfOpen: false,
    };
  }
}

/**
 * Returns the p-th percentile of an array using nearest-rank method.
 * Mutates the input by sorting it — caller should pass a copy if needed.
 */
function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(rank - 1, sorted.length - 1)]!;
}
