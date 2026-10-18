import type { ProviderAdapter, StreamRequest } from "../types";
import type { Provider } from "@/lib/router/router";
import { parseSse } from "../sse-parser";
import { checkMockFail } from "@/lib/test/check-mock-fail";

const MODEL = "openai/gpt-oss-120b"; // matches router CATALOG
const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

export const groqAdapter: ProviderAdapter = {
  name: "groq" as Provider,

  async *stream(req: StreamRequest) {
    // Test-only mock — no-op in production (endpoint gated by NODE_ENV).
    checkMockFail("groq");

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new Error("GROQ_API_KEY is not set");
    }

    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        messages: [
          ...(req.system
            ? [{ role: "system", content: req.system }]
            : []),
          ...req.messages.map((m) => ({ role: m.role, content: m.content })),
        ],
        temperature: 0.7,
      }),
      signal: req.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Groq ${res.status}: ${text.slice(0, 200)}`);
    }
    if (!res.body) {
      throw new Error("Groq returned no body");
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
    // Llama 3.3 70B on Groq pricing (late 2024):
    //   $0.59 / 1M input tokens
    //   $0.79 / 1M output tokens
    return (inTok / 1_000_000) * 0.59 + (outTok / 1_000_000) * 0.79;
  },

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  },
};
