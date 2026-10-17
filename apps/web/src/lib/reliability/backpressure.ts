// Backpressure + load shedding.
//
// When the system is overloaded (too many concurrent requests, queue depth
// too high), shed load by rejecting requests with 429 Too Many Requests.
// This prevents cascading failure: instead of letting the request pool
// exhaust + the whole system slow down, reject early + let the client retry.
//
// Two mechanisms:
//   1. Concurrency cap: per-route (or global) max in-flight requests. Over
//      the cap → 429. Prevents request-pool exhaustion.
//   2. Queue depth: if using a queue (Inngest, SQS), check the queue depth.
//      Over the threshold → 429 (don't enqueue more work — let the workers
//      catch up). Prevents queue backlog → unbounded latency.
//
// The spec: "Traffic spikes — autoscaling, load shedding, backpressure,
// queue-based processing."
//
// This is in-memory (per-instance). For multi-instance coordination, a shared
// counter (Redis) would be used. Per-instance is sufficient for shedding at
// the instance level (each instance protects itself).

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export class LoadShedError extends Error {
  constructor(
    public readonly reason: "concurrency_cap" | "queue_depth",
    public readonly limit: number,
    public readonly current: number,
  ) {
    super(`load_shed:${reason} (current=${current}, limit=${limit})`);
    this.name = "LoadShedError";
  }
}

interface ConcurrencyLimiterState {
  inFlight: number;
  totalAdmitted: number;
  totalShed: number;
  peakInFlight: number;
}

// ───────────────────────────────────────────────
// ConcurrencyLimiter — per-key concurrency cap
// ───────────────────────────────────────────────

const limiters = new Map<string, ConcurrencyLimiter>();

/**
 * Get or create a named concurrency limiter.
 *
 * @param name — the limiter key (e.g. 'api:global', 'ai:openai', 'payments:stripe').
 * @param maxConcurrent — the max in-flight requests (over → 429).
 */
export function concurrencyLimiter(name: string, maxConcurrent: number): ConcurrencyLimiter {
  let limiter = limiters.get(name);
  if (!limiter) {
    limiter = new ConcurrencyLimiter(name, maxConcurrent);
    limiters.set(name, limiter);
  }
  return limiter;
}

/** List all limiters (for the status endpoint). */
export function listConcurrencyLimiters(): Array<{ name: string; maxConcurrent: number; stats: ConcurrencyLimiterState }> {
  return Array.from(limiters.entries()).map(([name, l]) => ({
    name,
    maxConcurrent: l.maxConcurrent,
    stats: l.stats(),
  }));
}

export class ConcurrencyLimiter {
  readonly name: string;
  readonly maxConcurrent: number;
  private s: ConcurrencyLimiterState = {
    inFlight: 0,
    totalAdmitted: 0,
    totalShed: 0,
    peakInFlight: 0,
  };

  constructor(name: string, maxConcurrent: number) {
    this.name = name;
    this.maxConcurrent = maxConcurrent;
  }

  /**
   * Acquire a concurrency slot. Returns a release function.
   *
   * @throws LoadShedError if the concurrency cap is exceeded.
   *
   * Usage:
   *   const release = limiter.acquire();
   *   try { ... } finally { release(); }
   */
  acquire(): () => void {
    if (this.s.inFlight >= this.maxConcurrent) {
      this.s.totalShed++;
      throw new LoadShedError("concurrency_cap", this.maxConcurrent, this.s.inFlight);
    }
    this.s.inFlight++;
    this.s.totalAdmitted++;
    if (this.s.inFlight > this.s.peakInFlight) {
      this.s.peakInFlight = this.s.inFlight;
    }
    return () => {
      this.s.inFlight = Math.max(0, this.s.inFlight - 1);
    };
  }

  /** Current in-flight count. */
  get inFlight(): number {
    return this.s.inFlight;
  }

  /** Current stats. */
  stats(): ConcurrencyLimiterState {
    return { ...this.s };
  }
}

// ───────────────────────────────────────────────
// withBackpressure — middleware-style wrapper
// ───────────────────────────────────────────────

/**
 * Wrap an async function with backpressure (concurrency cap).
 *
 * @throws LoadShedError if the cap is exceeded.
 *
 * Usage:
 *   const result = await withBackpressure('ai:openai', 50, () => callOpenAI(...));
 */
export async function withBackpressure<T>(
  limiterName: string,
  maxConcurrent: number,
  fn: () => Promise<T>,
): Promise<T> {
  const limiter = concurrencyLimiter(limiterName, maxConcurrent);
  const release = limiter.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

// ───────────────────────────────────────────────
// Queue depth check (stub — real impl reads from Inngest/SQS)
// ───────────────────────────────────────────────

/**
 * Check if the queue depth is over the threshold → shed load.
 *
 * Stub: the real impl queries the queue service (Inngest API, SQS
 * ApproximateNumberOfMessages). Returns false (don't shed) by default.
 *
 * When wired, this would:
 *   1. Query the queue for the current depth.
 *   2. If depth > threshold → throw LoadShedError('queue_depth', threshold, depth).
 */
export async function checkQueueDepth(
  _queueName: string,
  _threshold: number,
): Promise<void> {
  // Stub — real impl queries Inngest/SQS.
  // return queueDepth > threshold ? throw new LoadShedError(...) : undefined.
}
