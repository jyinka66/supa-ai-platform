import type { Redis } from "@upstash/redis";

export interface ThrottledBufferOptions {
  /** Minimum time between Redis writes (default 250ms). */
  intervalMs: number;
  /** Flush early once pending content reaches this size (default 1KB). */
  sizeThresholdBytes: number;
  /** Redis key TTL in seconds (default 300 = 5 minutes). */
  ttlSeconds: number;
}

const DEFAULT_OPTIONS: ThrottledBufferOptions = {
  intervalMs: 250,
  sizeThresholdBytes: 1024,
  ttlSeconds: 300,
};

interface RedisLike {
  set: (key: string, value: string, opts?: { ex?: number; nx?: boolean }) => Promise<unknown>;
}

/**
 * Throttled Redis buffer for streaming responses.
 *
 * Stores the FULL accumulated content (not deltas) so the resume endpoint
 * always returns complete text. Coalesces writes based on time (max every
 * `intervalMs`) OR size (when pending content crosses `sizeThresholdBytes`).
 *
 * Usage:
 *   const buffer = new ThrottledStreamBuffer(streamId, redis);
 *   for await (const chunk of stream) {
 *     buffer.append(chunk.text);   // sync — never throws, never blocks
 *   }
 *   await buffer.destroy();        // final flush + cleanup
 *
 * Safety:
 *   - `append()` is sync and never throws — Redis errors are caught inside
 *     `flush()` so a Redis blip doesn't kill the LLM stream.
 *   - `destroy()` MUST be called when the stream ends to flush the final
 *     buffer and clear the timer.
 *   - Concurrent `flush()` calls coalesce via `flushPromise` so duplicate
 *     writes don't race.
 */
export class ThrottledStreamBuffer {
  private full = "";
  private dirty = false;
  private lastFlush = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushPromise: Promise<void> | null = null;
  private closed = false;
  private readonly encoder = new TextEncoder();

  constructor(
    private readonly streamId: string,
    private readonly redis: Redis,
    private readonly opts: ThrottledBufferOptions = DEFAULT_OPTIONS,
  ) {}

  /**
   * Appends a text delta to the buffer. Flushes to Redis if either:
   *   - the pending content crosses `sizeThresholdBytes`, OR
   *   - `intervalMs` has elapsed since the last flush.
   *
   * Otherwise schedules a timer to flush within `intervalMs`.
   *
   * Sync — never throws, never blocks. Redis write errors are caught inside
   * `flush()` and logged; the stream continues.
   */
  append(text: string): void {
    if (this.closed) return;
    this.full += text;
    this.dirty = true;

    const now = Date.now();
    const bytes = this.encoder.encode(this.full).length;

    if (bytes >= this.opts.sizeThresholdBytes || now - this.lastFlush >= this.opts.intervalMs) {
      void this.flush();
    } else if (!this.timer) {
      // Guarantee eventual write even for slow trickles.
      this.timer = setTimeout(() => {
        void this.flush().catch(() => {});
      }, this.opts.intervalMs);
    }
  }

  /**
   * Flushes the pending content to Redis.
   *
   * Concurrent calls coalesce — if a flush is already in flight, the
   * second caller awaits the same promise rather than issuing a duplicate
   * write.
   *
   * After `destroy()` is called, flushes are no-ops.
   */
  async flush(): Promise<void> {
    if (this.closed) return;

    // Clear the scheduled timer — we're flushing now.
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // Coalesce concurrent flush calls.
    if (this.flushPromise) {
      return this.flushPromise;
    }

    if (!this.dirty) return;

    const snapshot = this.full;
    this.flushPromise = this.redis
      .set(`stream:${this.streamId}`, snapshot, { ex: this.opts.ttlSeconds })
      .then(() => {
        this.dirty = false;
        this.lastFlush = Date.now();
      })
      .catch((err) => {
        // Redis write failed — don't kill the stream. Keep `dirty = true`
        // so the next append retries. Log for observability.
        console.warn(
          JSON.stringify({
            event: "stream_buffer_flush_failed",
            stream_id: this.streamId,
            bytes: snapshot.length,
            error: String(err),
          }),
        );
      })
      .finally(() => {
        this.flushPromise = null;
      });

    return this.flushPromise;
  }

  /**
   * Returns the current full accumulated content. Useful for the streaming
   * route to persist the final message without re-reading from Redis.
   */
  content(): string {
    return this.full;
  }

  /**
   * Final flush + cleanup. MUST be called when the stream ends (success,
   * error, or client disconnect) so the final content is persisted.
   *
   * After `destroy()`, further `append()` / `flush()` calls are no-ops.
   */
  async destroy(): Promise<void> {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Wait for any in-flight flush to complete before issuing the final one.
    if (this.flushPromise) {
      await this.flushPromise;
    }
    // Final flush — persist any content accumulated since the last write.
    if (this.dirty) {
      try {
        await this.redis.set(`stream:${this.streamId}`, this.full, {
          ex: this.opts.ttlSeconds,
        });
        this.dirty = false;
        this.lastFlush = Date.now();
      } catch (err) {
        console.warn(
          JSON.stringify({
            event: "stream_buffer_destroy_failed",
            stream_id: this.streamId,
            bytes: this.full.length,
            error: String(err),
          }),
        );
      }
    }
  }
}

/**
 * Factory helper — creates a buffer with sensible defaults.
 * Pass a real Redis client from `@upstash/redis`.
 */
export function createStreamBuffer(streamId: string, redis: Redis): ThrottledStreamBuffer {
  return new ThrottledStreamBuffer(streamId, redis, DEFAULT_OPTIONS);
}
