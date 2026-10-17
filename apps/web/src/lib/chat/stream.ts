import type { NextRequest } from "next/server";
import { audit } from "@/lib/audit";

/**
 * Streams tokens from a provider to a client, with graceful abort handling.
 *
 * When the client disconnects (closes the SSE connection, navigates away,
 * or clicks "Stop"), we:
 *   1. Abort the in-flight provider call (cancels the HTTP request → stops
 *      token generation → stops cost accrual at the provider)
 *   2. Bill only the tokens actually received (not the full response)
 *   3. Audit the abort so we can measure "user-initiated abort rate" as
 *      a product metric
 *
 * This is a generic helper — the streaming route passes its provider call
 * + onToken callback + onComplete callback. The helper handles abort
 * wiring, token counting, and audit logging.
 */

export interface ProviderChunk {
  text: string;
  /** Optional token count from the provider (more accurate than estimating). */
  tokens?: number;
}

export interface StreamUsage {
  outputTokens: number;
  aborted: boolean;
}

export interface StreamToClientOptions {
  /** The incoming HTTP request — used to detect client disconnect. */
  request: NextRequest;
  /** The provider call (returns an async iterable of chunks). */
  providerCall: (signal: AbortSignal) => AsyncIterable<ProviderChunk>;
  /** Called for each text chunk — typically enqueues to an SSE controller. */
  onToken: (text: string) => void;
  /** Called when the stream completes (success OR abort). Persists the message. */
  onComplete: (usage: StreamUsage) => Promise<void>;
  /** Audit context — what message this stream belongs to. */
  auditContext?: {
    messageId: string;
    actorId: string | null;
  };
}

/**
 * Streams tokens from a provider to a client, with graceful abort.
 *
 * Flow:
 *   1. Set up AbortController wired to `request.signal`
 *   2. Iterate the provider's async iterable
 *   3. Count tokens (use provider's count if available, else estimate)
 *   4. Call `onToken(chunk.text)` for each chunk
 *   5. On normal completion: call `onComplete({ outputTokens, aborted: false })`
 *   6. On client disconnect: call `onComplete({ outputTokens, aborted: true })`
 *      + audit the abort
 *   7. On provider error: re-throw (caller handles fallback)
 *
 * The `onComplete` callback is responsible for persisting the message with
 * the correct status (`completed` vs `aborted`) and billing only the tokens
 * actually received.
 */
export async function streamToClient(opts: StreamToClientOptions): Promise<void> {
  const controller = new AbortController();

  // Wire client disconnect → abort provider call.
  const abortOnDisconnect = () => controller.abort();
  opts.request.signal.addEventListener("abort", abortOnDisconnect);

  let outputTokens = 0;
  let completed = false;
  let aborted = false;

  try {
    for await (const chunk of opts.providerCall(controller.signal)) {
      if (controller.signal.aborted) {
        // Client disconnected mid-iteration — stop consuming.
        break;
      }
      outputTokens += chunk.tokens ?? estimateTokens(chunk.text);
      opts.onToken(chunk.text);
    }
    completed = !controller.signal.aborted;
    aborted = controller.signal.aborted;
  } catch (err) {
    if (controller.signal.aborted) {
      // Client went away — this is normal, not an error.
      // Bill what we got + audit the abort.
      aborted = true;
      await opts.onComplete({ outputTokens, aborted: true });

      if (opts.auditContext) {
        await audit({
          actorId: opts.auditContext.actorId,
          actorKind: "system",
          action: "conversation.message_aborted",
          targetType: "message",
          targetId: opts.auditContext.messageId,
          metadata: { partialTokens: outputTokens },
        });
      }
      return;
    }
    // Genuine provider failure — re-throw for the caller's fallback path.
    throw err;
  } finally {
    opts.request.signal.removeEventListener("abort", abortOnDisconnect);
  }

  if (completed) {
    await opts.onComplete({ outputTokens, aborted: false });
  } else if (aborted) {
    // Loop exited via break (client disconnect detected mid-iteration).
    await opts.onComplete({ outputTokens, aborted: true });

    if (opts.auditContext) {
      await audit({
        actorId: opts.auditContext.actorId,
        actorKind: "system",
        action: "conversation.message_aborted",
        targetType: "message",
        targetId: opts.auditContext.messageId,
        metadata: { partialTokens: outputTokens },
      });
    }
  }
}

/**
 * Rough token estimate when the provider doesn't return a token count.
 * ~4 chars per token for Latin scripts, ~2 for CJK.
 *
 * This is the same heuristic used by the provider adapters' `estimateTokens()`.
 */
function estimateTokens(text: string): number {
  // CJK characters (roughly) count as 1 token each.
  const cjk = (text.match(/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/g) ?? []).length;
  const latin = text.length - cjk;
  return Math.ceil(latin / 4 + cjk);
}
