/**
 * SSE event encoding + Redis-backed chunk buffering for mobile reconnection.
 *
 * Problem: mobile networks drop constantly. The native EventSource API
 * auto-reconnects and sends `Last-Event-ID`, but our chat uses fetch
 * (for streaming + abort control). So we:
 *   1. Assign sequential IDs to each SSE event
 *   2. Buffer chunks in Redis with a 120s TTL
 *   3. On reconnect, the client sends `Last-Event-ID` and we replay
 *      only the chunks after that ID
 *
 * The buffer is per (conversationId, messageId) — a reconnect fetches
 * the current stream's buffer and replays from `Last-Event-ID + 1`.
 *
 * After 120s (BUFFER_TTL_SEC), the buffer expires — the client must
 * refetch the full message from the DB (via GET /api/conversations/:id/messages).
 */

import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
const BUFFER_TTL_SEC = 120; // 2 minutes — mobile reconnect window

export interface BufferedChunk {
  /** Sequence number — monotonically increasing per stream. */
  seq: number;
  /** The SSE event type ("delta" | "done" | "error" | "fallback"). */
  event: string;
  /** The JSON-encoded data payload. */
  data: string;
  /** The text content (for "delta" events; empty for others). */
  text: string;
}

/**
 * Encodes an SSE event with a numeric ID.
 *
 * Format per the SSE spec:
 *   id: 42
 *   event: delta
 *   data: {"text":"Hello"}
 *
 * The `id:` line is what EventSource uses for `Last-Event-ID` on reconnect.
 *
 * @example
 *   sseEvent(42, "delta", { text: "Hello" })
 *   // → "id: 42\nevent: delta\ndata: {\"text\":\"Hello\"}\n\n"
 */
export function sseEvent(id: number, event: string, data: unknown): string {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return `id: ${id}\nevent: ${event}\ndata: ${payload}\n\n`;
}

/**
 * Buffers a chunk in Redis for replay on reconnect.
 *
 * Uses RPUSH to append to a list keyed by (conversationId, messageId).
 * The list expires after BUFFER_TTL_SEC (120s) — after that, the client
 * must refetch from the DB.
 *
 * @example
 *   await bufferChunk(convId, msgId, 42, "delta", '{"text":"Hello"}', "Hello");
 */
export async function bufferChunk(
  conversationId: string,
  messageId: string,
  seq: number,
  event: string,
  data: string,
  text: string,
): Promise<void> {
  const key = `ssebuf:${conversationId}:${messageId}`;
  const chunk: BufferedChunk = { seq, event, data, text };
  await redis.rpush(key, JSON.stringify(chunk));
  await redis.expire(key, BUFFER_TTL_SEC);
}

/**
 * Returns all buffered chunks for a stream.
 *
 * Used by the reconnect endpoint to replay events after `Last-Event-ID`.
 *
 * @param lastEventId  The last event ID the client received. We return
 *                     only chunks with seq > lastEventId. Pass 0 (or -1)
 *                     to get all chunks.
 */
export async function getBufferedChunks(
  conversationId: string,
  messageId: string,
  lastEventId: number = 0,
): Promise<BufferedChunk[]> {
  const key = `ssebuf:${conversationId}:${messageId}`;
  const raw = await redis.lrange<BufferedChunk>(key, 0, -1);
  if (!raw || raw.length === 0) return [];

  return raw
    .map((item) => {
      if (typeof item === "string") {
        try {
          return JSON.parse(item) as BufferedChunk;
        } catch {
          return null;
        }
      }
      return item;
    })
    .filter((c): c is BufferedChunk => c !== null)
    .filter((c) => c.seq > lastEventId);
}

/**
 * Returns the highest seq number in the buffer (for setting the next
 * event ID on reconnect).
 */
export async function getLastSeq(
  conversationId: string,
  messageId: string,
): Promise<number> {
  const key = `ssebuf:${conversationId}:${messageId}`;
  const raw = await redis.lrange<BufferedChunk>(key, -1, -1);
  if (!raw || raw.length === 0) return 0;
  const last = typeof raw[0] === "string" ? JSON.parse(raw[0] as string) : raw[0];
  return last?.seq ?? 0;
}

/**
 * Clears the buffer for a stream (called on successful completion or
 * when the stream is aborted).
 */
export async function clearBuffer(
  conversationId: string,
  messageId: string,
): Promise<void> {
  const key = `ssebuf:${conversationId}:${messageId}`;
  await redis.del(key);
}

export { BUFFER_TTL_SEC };
