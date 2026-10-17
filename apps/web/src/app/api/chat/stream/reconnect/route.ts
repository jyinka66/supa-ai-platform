import { NextRequest } from "next/server";
import { getCtx } from "@/lib/observability/context";
import { guard } from "@/lib/ratelimit/guard";
import { problem } from "@/lib/api/problem";
import { getBufferedChunks, sseEvent } from "@/lib/chat/sse-buffer";
import { Redis } from "@upstash/redis";
import { z } from "zod";

const redis = Redis.fromEnv();

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  conversationId: z.string().uuid(),
  messageId: z.string().uuid(),
});

/**
 * GET /api/chat/stream/reconnect?conversationId=...&messageId=...
 *
 * Mobile SSE reconnection — replays buffered chunks after a network drop.
 *
 * Flow:
 *   1. Client detects disconnect (fetch aborts or errors)
 *   2. Client sends `Last-Event-ID: <seq>` header on reconnect
 *   3. Server fetches buffered chunks with seq > lastEventId
 *   4. Server replays them as SSE events with the same IDs
 *   5. If the stream completed while the client was away, sends `done`
 *   6. If the stream is still live, attaches as a passive subscriber
 *
 * This is SEPARATE from GET /api/chat/stream?streamId=... (which is a
 * simpler resume that returns the full accumulated content). This route
 * handles the case where the client wants to continue receiving live
 * chunks from where it left off.
 *
 * Auth: caller must own the conversation (RLS enforces, but we also check
 * here for a clean 403).
 *
 * Rate-limited at the `chat` tier (same as the POST stream route).
 */
export async function GET(req: NextRequest) {
  const denied = await guard(req, "chat");
  if (denied) return denied;

  const ctx = getCtx();
  if (!ctx.userId) {
    return problem(401, "unauthenticated");
  }

  // Parse + validate query params.
  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    conversationId: url.searchParams.get("conversationId"),
    messageId: url.searchParams.get("messageId"),
  });
  if (!parsed.success) {
    return problem(400, "missing_params", parsed.error.issues[0]?.message);
  }
  const { conversationId, messageId } = parsed.data;

  // Authorization: verify the user owns the conversation.
  const { getConversation } = await import("@/lib/chat/queries");
  try {
    await getConversation(conversationId, ctx.userId);
  } catch {
    return problem(403, "forbidden");
  }

  // Parse Last-Event-ID header — the client tells us the last seq it received.
  const lastEventIdRaw = req.headers.get("last-event-id") ?? "-1";
  const lastSeq = Math.max(-1, parseInt(lastEventIdRaw, 10) || -1);

  // Fetch buffered chunks after lastSeq.
  const chunks = await getBufferedChunks(conversationId, messageId, lastSeq);

  // Check if the stream completed while the client was away.
  // The generating request stores status + full text in Redis.
  const msgStatus = await redis.hget<{ status: string; fullText: string }>(
    `msg:${messageId}`,
    "status",
  );

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const cleanup = () => {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };

      // 1. Replay buffered chunks.
      for (const chunk of chunks) {
        try {
          const data = JSON.parse(chunk.data);
          controller.enqueue(
            encoder.encode(sseEvent(chunk.seq, chunk.event, data)),
          );
        } catch {
          // Skip malformed chunks.
        }
      }

      // 2. If the stream completed, send the `done` event and close.
      if (msgStatus?.status === "completed") {
        const nextSeq = chunks.length > 0 ? chunks[chunks.length - 1]!.seq + 1 : lastSeq + 1;
        controller.enqueue(
          encoder.encode(
            sseEvent(nextSeq, "done", {
              messageId,
              total: msgStatus.fullText,
            }),
          ),
        );
        cleanup();
        return;
      }

      // 3. If the stream errored, send the `error` event and close.
      if (msgStatus?.status === "error") {
        const nextSeq = chunks.length > 0 ? chunks[chunks.length - 1]!.seq + 1 : lastSeq + 1;
        controller.enqueue(
          encoder.encode(
            sseEvent(nextSeq, "error", {
              allProvidersFailed: true,
            }),
          ),
        );
        cleanup();
        return;
      }

      // 4. Still generating — subscribe to the live pub/sub channel.
      const lastBufferedSeq = chunks.length > 0 ? chunks[chunks.length - 1]!.seq : lastSeq;
      await tailLive(controller, messageId, lastBufferedSeq, cleanup);
    },
    cancel() {
      // Client disconnected — the pub/sub subscription is cleaned up
      // automatically when the subscriber returns.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Request-Id": ctx.requestId,
    },
  });
}

/**
 * Tails the live pub/sub channel for a message stream.
 *
 * Subscribes to `ssechan:<messageId>` and enqueues chunks as they arrive.
 * The generating request publishes:
 *   redis.publish(`ssechan:${messageId}`, JSON.stringify({ seq, event, data, text }))
 *
 * When the generating request publishes a `done` or `error` event,
 * this function closes the stream.
 */
async function tailLive(
  controller: ReadableStreamDefaultController<Uint8Array>,
  messageId: string,
  startSeq: number,
  cleanup: () => void,
): Promise<void> {
  const encoder = new TextEncoder();
  const channel = `ssechan:${messageId}`;
  let currentSeq = startSeq;

  return new Promise<void>((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    // Subscribe via Upstash Redis.
    // Upstash's subscribe API returns a Subscriber; listen on 'message' + 'error'.
    const subscriber = redis.subscribe(channel);
    subscriber.on("message", ((_key: string, message: unknown) => {
      try {
        const chunk = JSON.parse(typeof message === "string" ? message : String(message)) as {
          seq: number;
          event: string;
          data: unknown;
          text: string;
        };

        if (chunk.seq <= currentSeq) return; // deduplicate
        currentSeq = chunk.seq;

        controller.enqueue(
          encoder.encode(sseEvent(chunk.seq, chunk.event, chunk.data)),
        );

        if (chunk.event === "done" || chunk.event === "error") {
          finish();
        }
      } catch {
        // Malformed message — skip.
      }
    }) as never);
    subscriber.on("error", () => {
      // Subscription failed — close the stream.
      finish();
    });

    // Safety timeout — if no events arrive within 60s, close.
    // The client will reconnect again.
    setTimeout(() => {
      finish();
    }, 60_000);
  });
}
