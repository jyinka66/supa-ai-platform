import type { ProviderAdapter, StreamRequest } from "../types";
import type { Provider } from "@/lib/router/router";
import { parseSse } from "../sse-parser";
import { checkMockFail } from "@/lib/test/check-mock-fail";

const MODEL = "gemini-3.8-flash"; // matches router CATALOG
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`;

export const geminiAdapter: ProviderAdapter = {
  name: "gemini" as Provider,

  async *stream(req: StreamRequest) {
    // Test-only mock — no-op in production (endpoint gated by NODE_ENV).
    checkMockFail("gemini");

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not set");
    }

    const res = await fetch(`${ENDPOINT}&key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: req.system ? { parts: [{ text: req.system }] } : undefined,
        contents: req.messages.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
        generationConfig: {
          temperature: 0.7,
        },
      }),
      signal: req.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Gemini ${res.status}: ${text.slice(0, 200)}`);
    }
    if (!res.body) {
      throw new Error("Gemini returned no body");
    }

    for await (const data of parseSse(res.body, req.signal)) {
      if (data === "[DONE]") return;
      try {
        const json = JSON.parse(data);
        const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (typeof text === "string" && text.length > 0) {
          yield text;
        }
      } catch {
        // Skip malformed chunks — Gemini sometimes emits partial JSON.
      }
    }
  },

  estimateCost(inTok: number, outTok: number): number {
    // Gemini 2.0 Flash pricing (as of late 2024):
    //   $0.075 / 1M input tokens
    //   $0.30  / 1M output tokens
    return (inTok / 1_000_000) * 0.075 + (outTok / 1_000_000) * 0.3;
  },

  estimateTokens(text: string): number {
    // Rough: 4 chars per token for Latin scripts, 1.5 for CJK.
    // Good enough for budget pre-checks — actual counts come back from the API.
    return Math.ceil(text.length / 4);
  },
};
