import type { ProviderAdapter, StreamRequest } from "../types";
import type { Provider } from "@/lib/router/router";
import { parseSse } from "../sse-parser";
import { checkMockFail } from "@/lib/test/check-mock-fail";

/**
 * OpenRouter is a meta-provider — it routes to many upstream models.
 * We use `openrouter/auto` so OpenRouter picks the best model for the
 * request, but a real deployment would pin to a specific model per
 * RouteMode (e.g. anthropic/claude-3.5-sonnet for `write`, openai/gpt-4o
 * for `code`, etc.).
 */
const MODEL = "openrouter/auto"; // matches router CATALOG
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export const openrouterAdapter: ProviderAdapter = {
  name: "openrouter" as Provider,

  async *stream(req: StreamRequest) {
    // Test-only mock — no-op in production (endpoint gated by NODE_ENV).
    checkMockFail("openrouter");

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error("OPENROUTER_API_KEY is not set");
    }

    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
        "X-Title": "Supa AI",
      },
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        messages: [
          ...(req.system ? [{ role: "system", content: req.system }] : []),
          ...req.messages.map((m) => ({ role: m.role, content: m.content })),
        ],
        temperature: 0.7,
      }),
      signal: req.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 200)}`);
    }
    if (!res.body) {
      throw new Error("OpenRouter returned no body");
    }

    for await (const data of parseSse(res.body, req.signal)) {
      if (data === "[DONE]") return;
      try {
        const json = JSON.parse(data);
        const delta = json?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) {
          yield delta;
        }
      } catch {
        // Skip malformed chunks.
      }
    }
  },

  estimateCost(inTok: number, outTok: number): number {
    // OpenRouter pricing varies wildly per model. Use a blended average
    // based on the auto-router's typical picks (~$0.50 / 1M input,
    // ~$1.50 / 1M output for mid-tier models).
    return (inTok / 1_000_000) * 0.5 + (outTok / 1_000_000) * 1.5;
  },

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  },
};
