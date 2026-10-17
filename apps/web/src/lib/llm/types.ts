import type { Provider } from "@/lib/router/router";

export interface StreamRequest {
  system: string;
  /** Conversation history in chronological order (most recent last). */
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  language: string;
  /** Abort signal from the caller — provider must respect it. */
  signal?: AbortSignal;
  /** Conversation id (for logging / correlation only). */
  conversationId?: string;
}

export interface ProviderAdapter {
  readonly name: Provider;
  /**
   * Streams text chunks from the provider.
   *
   * Implementations MUST:
   *   - Respect the `signal` argument (abort on disconnect)
   *   - Throw on HTTP errors so the router can fail over
   *   - Yield only text deltas (no metadata)
   *   - Handle SSE / chunked-JSON / multipart responses internally
   */
  stream(req: StreamRequest): AsyncGenerator<string, void, unknown>;
  /** USD cost for a request with the given token counts. */
  estimateCost(inputTokens: number, outputTokens: number): number;
  /** Rough token estimate for text input (for budget pre-checks). */
  estimateTokens(text: string): number;
}

export type { Provider };
