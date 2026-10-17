// Circuit breaker — the core reliability primitive.
//
// Protects against cascading failures when a downstream dependency (AI
// provider, payment provider, external API) is slow or down. Instead of
// every request waiting for a timeout (which exhausts the request pool +
// makes the whole system slow), the circuit breaker "trips" after N
// failures → fast-fails subsequent requests immediately (returns a fallback
// or throws) → gives the downstream time to recover → "half-opens" to test
// if it's back.
//
// States:
//   - CLOSED:    requests flow normally. Failures are counted.
//   - OPEN:      requests fast-fail immediately (no downstream call).
//                After `cooldownMs`, transition to HALF_OPEN.
//   - HALF_OPEN: a single request is allowed through (a "probe"). If it
//                succeeds → CLOSED (reset). If it fails → OPEN (re-cooldown).
//
// The spec: "Circuit breakers verified for AI and payment providers."
//
// This is an in-memory implementation (no persistence — state is reconstructed
// from the request stream on restart). For multi-instance deployments, a
// shared store (Redis) would coordinate the state across instances. For now,
// per-instance breakers are sufficient (each instance independently trips —
// a slow downstream trips all instances, which is the desired behavior).
//
// Usage:
//   const breaker = circuitBreaker('openai', { failureThreshold: 5, cooldownMs: 30000 });
//   const result = await breaker.exec(() => callOpenAI(...));
//   // → throws CircuitOpenError if the circuit is open (fast-fail).
//   // → throws the original error if the downstream fails (counted toward threshold).
//   // → returns the result on success.

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before tripping (default 5). */
  failureThreshold: number;
  /** Cooldown after tripping before half-open probe (default 30s). */
  cooldownMs: number;
  /** Timeout for each exec call (default 10s — prevents slow downstreams from holding the request pool). */
  timeoutMs: number;
  /** Half-open: allow N probes simultaneously (default 1). */
  halfOpenMaxCalls: number;
  /**
   * Determine if an error should count as a failure (default: all errors count).
   * Override to exclude e.g. 4xx client errors (those aren't downstream failures).
   */
  shouldCountAsFailure?: (err: unknown) => boolean;
}

export class CircuitOpenError extends Error {
  constructor(
    public readonly name_: string,
    message?: string,
  ) {
    super(message ?? `circuit_open:${name_}`);
    this.name = "CircuitOpenError";
  }
}

export class CircuitTimeoutError extends Error {
  constructor(
    public readonly name_: string,
    timeoutMs: number,
  ) {
    super(`circuit_timeout:${name_} after ${timeoutMs}ms`);
    this.name = "CircuitTimeoutError";
  }
}

interface CircuitBreakerState {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  lastFailureAt: number | null;
  openedAt: number | null;
  halfOpenInFlight: number;
  totalRequests: number;
  totalFailures: number;
  totalTimeouts: number;
  totalRejected: number;
}

// ───────────────────────────────────────────────
// Registry — named breakers (shared across the app)
// ───────────────────────────────────────────────

const registry = new Map<string, CircuitBreaker>();

/** Get or create a named circuit breaker. */
export function circuitBreaker(name: string, opts?: Partial<CircuitBreakerOptions>): CircuitBreaker {
  let breaker = registry.get(name);
  if (!breaker) {
    breaker = new CircuitBreaker(name, opts);
    registry.set(name, breaker);
  }
  return breaker;
}

/** List all registered breakers (for the /api/admin/status endpoint). */
export function listCircuitBreakers(): Array<{ name: string; state: CircuitState; stats: CircuitBreakerState }> {
  return Array.from(registry.entries()).map(([name, b]) => ({
    name,
    state: b.state,
    stats: b.stats(),
  }));
}

/** Reset a named breaker (manual override — for ops). */
export function resetCircuitBreaker(name: string): boolean {
  const breaker = registry.get(name);
  if (!breaker) return false;
  breaker.reset();
  return true;
}

// ───────────────────────────────────────────────
// CircuitBreaker implementation
// ───────────────────────────────────────────────

const DEFAULT_OPTS: CircuitBreakerOptions = {
  failureThreshold: 5,
  cooldownMs: 30_000,
  timeoutMs: 10_000,
  halfOpenMaxCalls: 1,
};

export class CircuitBreaker {
  readonly name: string;
  private readonly opts: CircuitBreakerOptions;
  private s: CircuitBreakerState = {
    state: "closed",
    failureCount: 0,
    successCount: 0,
    lastFailureAt: null,
    openedAt: null,
    halfOpenInFlight: 0,
    totalRequests: 0,
    totalFailures: 0,
    totalTimeouts: 0,
    totalRejected: 0,
  };

  constructor(name: string, opts?: Partial<CircuitBreakerOptions>) {
    this.name = name;
    this.opts = { ...DEFAULT_OPTS, ...opts };
  }

  /** Current state. */
  get state(): CircuitState {
    this.maybeTransitionToHalfOpen();
    return this.s.state;
  }

  /**
   * Execute a function with circuit-breaker protection.
   *
   * @throws CircuitOpenError if the circuit is open (fast-fail — no downstream call).
   * @throws CircuitTimeoutError if the function exceeds the timeout.
   * @throws the original error if the function fails (counted toward threshold).
   * @returns the function's result on success.
   */
  async exec<T>(fn: () => Promise<T>): Promise<T> {
    this.maybeTransitionToHalfOpen();

    // CLOSED / HALF_OPEN → allow the request (with limits in HALF_OPEN).
    if (this.s.state === "open") {
      this.s.totalRejected++;
      throw new CircuitOpenError(this.name);
    }

    if (this.s.state === "half_open" && this.s.halfOpenInFlight >= this.opts.halfOpenMaxCalls) {
      // Too many half-open probes in flight — reject (the probe is still running).
      this.s.totalRejected++;
      throw new CircuitOpenError(this.name);
    }

    if (this.s.state === "half_open") {
      this.s.halfOpenInFlight++;
    }

    this.s.totalRequests++;

    try {
      // Apply the timeout.
      const result = await this.withTimeout(fn, this.opts.timeoutMs);

      // Success → reset the failure count, transition to CLOSED if half-open.
      this.onSuccess();
      return result;
    } catch (err) {
      // Timeout → count as failure + increment the timeout counter.
      if (err instanceof CircuitTimeoutError) {
        this.s.totalTimeouts++;
        this.onFailure(err);
        throw err;
      }

      // Check if the error should count as a failure.
      const counts = this.opts.shouldCountAsFailure ? this.opts.shouldCountAsFailure(err) : true;
      if (counts) {
        this.onFailure(err);
      }
      throw err;
    } finally {
      if (this.s.state === "half_open") {
        this.s.halfOpenInFlight = Math.max(0, this.s.halfOpenInFlight - 1);
      }
    }
  }

  /** Wrap a promise with a timeout. */
  private withTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new CircuitTimeoutError(this.name, timeoutMs));
      }, timeoutMs);

      fn()
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  /** On success: reset failure count. If half-open → closed. */
  private onSuccess(): void {
    this.s.failureCount = 0;
    this.s.successCount++;
    if (this.s.state === "half_open") {
      this.s.state = "closed";
      this.s.openedAt = null;
      this.s.halfOpenInFlight = 0;
    }
  }

  /** On failure: increment failure count. Trip if threshold reached. */
  private onFailure(_err: unknown): void {
    this.s.failureCount++;
    this.s.totalFailures++;
    this.s.lastFailureAt = Date.now();

    if (this.s.state === "half_open") {
      // Half-open probe failed → re-open (re-cooldown).
      this.trip();
      return;
    }

    if (this.s.failureCount >= this.opts.failureThreshold) {
      this.trip();
    }
  }

  /** Trip the circuit (CLOSED → OPEN). */
  private trip(): void {
    this.s.state = "open";
    this.s.openedAt = Date.now();
    this.s.halfOpenInFlight = 0;
  }

  /** Transition OPEN → HALF_OPEN if the cooldown has elapsed. */
  private maybeTransitionToHalfOpen(): void {
    if (this.s.state !== "open") return;
    if (this.s.openedAt === null) return;

    if (Date.now() - this.s.openedAt >= this.opts.cooldownMs) {
      this.s.state = "half_open";
      this.s.halfOpenInFlight = 0;
    }
  }

  /** Manual reset (for ops). */
  reset(): void {
    this.s = {
      state: "closed",
      failureCount: 0,
      successCount: 0,
      lastFailureAt: null,
      openedAt: null,
      halfOpenInFlight: 0,
      totalRequests: 0,
      totalFailures: 0,
      totalTimeouts: 0,
      totalRejected: 0,
    };
  }

  /** Current stats (for the status endpoint). */
  stats(): CircuitBreakerState {
    return { ...this.s };
  }
}
