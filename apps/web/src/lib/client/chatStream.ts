"use client";

import type { ChatRequest } from "@/lib/schemas";

export interface StreamHandlers {
  onDelta: (text: string) => void;
  onDone: (messageId?: string) => void;
  onError: (error: Error) => void;
  onFallback?: (from: string, to: string) => void;
  onReconnect?: (attempt: number) => void;
}

export interface StreamChatOptions {
  /** Max reconnect attempts (default 3). */
  maxRetries?: number;
  /** Base backoff in ms (default 500). */
  baseBackoffMs?: number;
  /** Max backoff in ms (default 5000). */
  maxBackoffMs?: number;
  /** Abort signal — if aborted, the stream stops without error. */
  signal?: AbortSignal;
}

interface ParsedSseEvent {
  id: number;
  event: string;
  data: unknown;
}

/**
 * Streams a chat response with automatic reconnection on network drop.
 *
 * Flow:
 *   1. POST to /api/chat/stream — starts the generation
 *   2. Read SSE events, tracking the last `id` received
 *   3. On network error (not abort):
 *      a. Wait with exponential backoff + jitter
 *      b. GET /api/chat/stream/reconnect?conversationId=...&messageId=...
 *         with `Last-Event-ID: <lastSeq>` header
 *      c. Replay buffered chunks, then tail the live stream
 *   4. On `done` event: call onDone + return
 *   5. On user abort: return without error
 *
 * The client tracks `lastSeq` so the server knows which chunks to replay.
 *
 * @example
 *   const ac = new AbortController();
 *   await streamChat(
 *     { conversationId, content, idempotencyKey, mode: "chat", language: "en" },
 *     {
 *       onDelta: (text) => appendToUI(text),
 *       onDone: (messageId) => finalizeUI(messageId),
 *       onError: (err) => showError(err),
 *     },
 *     { signal: ac.signal },
 *   );
 */
export async function streamChat(
  body: ChatRequest,
  handlers: StreamHandlers,
  opts: StreamChatOptions = {},
): Promise<void> {
  const maxRetries = opts.maxRetries ?? 3;
  const baseBackoff = opts.baseBackoffMs ?? 500;
  const maxBackoff = opts.maxBackoffMs ?? 5000;

  let lastSeq = -1;
  let messageId: string | undefined;
  let conversationId = body.conversationId;
  let retries = 0;

  // Outer loop: retry on network drop.
  while (true) {
    // Check if the user aborted.
    if (opts.signal?.aborted) return;

    try {
      // First attempt: POST to start the stream.
      // Reconnect attempts: GET to replay + tail.
      const isReconnect = retries > 0 && messageId !== undefined && conversationId;

      const res = isReconnect
        ? await fetch(
            `/api/chat/stream/reconnect?conversationId=${conversationId}&messageId=${messageId}`,
            {
              method: "GET",
              headers: {
                ...(lastSeq >= 0 && { "Last-Event-ID": String(lastSeq) }),
              },
              signal: opts.signal,
            },
          )
        : await fetch("/api/chat/stream", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(lastSeq >= 0 && { "Last-Event-ID": String(lastSeq) }),
            },
            body: JSON.stringify(body),
            signal: opts.signal,
          });

      if (!res.ok || !res.body) {
        // Non-retryable errors (4xx except 429).
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          const errBody = await res.json().catch(() => ({}));
          throw new Error(errBody.error ?? `stream_failed_${res.status}`);
        }
        // Retryable: 429, 5xx.
        throw new Error(`stream_retryable_${res.status}`);
      }

      // Parse SSE events from the response body.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by \n\n.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? ""; // keep the last (possibly incomplete) frame

        for (const frame of frames) {
          const parsed = parseSseFrame(frame);
          if (!parsed) continue;

          if (parsed.event === "delta") {
            lastSeq = parsed.id;
            const text = (parsed.data as { text?: string }).text ?? "";
            handlers.onDelta(text);
          } else if (parsed.event === "done") {
            const data = parsed.data as { messageId?: string };
            messageId = data.messageId ?? messageId;
            handlers.onDone(messageId);
            return;
          } else if (parsed.event === "fallback") {
            const data = parsed.data as { from?: string; to?: string };
            if (data.from && data.to) {
              handlers.onFallback?.(data.from, data.to);
            }
          } else if (parsed.event === "error") {
            const data = parsed.data as {
              partial?: boolean;
              content?: string;
              allProvidersFailed?: boolean;
            };
            if (data.partial && data.content) {
              // Show partial content, then error.
              handlers.onDelta(data.content);
            }
            if (data.allProvidersFailed) {
              handlers.onError(new Error("all_providers_failed"));
              return;
            }
          }
        }
      }

      // Server closed without `done` — likely a network drop.
      // Fall through to retry.
      throw new Error("stream_closed_without_done");
    } catch (err) {
      // User aborted — stop without error.
      if (opts.signal?.aborted) return;
      if (err instanceof Error && err.name === "AbortError") return;

      // Max retries exceeded.
      if (retries >= maxRetries) {
        handlers.onError(
          err instanceof Error ? err : new Error(String(err)),
        );
        return;
      }

      // Exponential backoff with jitter.
      retries++;
      handlers.onReconnect?.(retries);
      await sleep(backoffMs(retries, baseBackoff, maxBackoff));
    }
  }
}

/**
 * Parses a single SSE frame into { id, event, data }.
 *
 * SSE frame format:
 *   id: 42
 *   event: delta
 *   data: {"text":"Hello"}
 *
 * Multiple `data:` lines are joined with \n per the SSE spec.
 */
function parseSseFrame(frame: string): ParsedSseEvent | null {
  const lines = frame.split("\n");
  let id = -1;
  let event = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("id: ")) {
      id = parseInt(line.slice(4), 10) || -1;
    } else if (line.startsWith("event: ")) {
      event = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      dataLines.push(line.slice(6));
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5));
    }
  }

  if (dataLines.length === 0) return null;

  const dataStr = dataLines.join("\n");
  let data: unknown;
  try {
    data = JSON.parse(dataStr);
  } catch {
    data = { raw: dataStr };
  }

  return { id, event, data };
}

/**
 * Exponential backoff with jitter.
 *
 * attempt 1: 500ms + jitter (0-250ms)
 * attempt 2: 1000ms + jitter
 * attempt 3: 2000ms + jitter
 * capped at maxBackoff.
 */
function backoffMs(attempt: number, base: number, max: number): number {
  const exponential = base * Math.pow(2, attempt - 1);
  const capped = Math.min(exponential, max);
  const jitter = Math.random() * (capped / 2);
  return Math.round(capped + jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
