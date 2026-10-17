import type { Provider } from "@/lib/router/router";
import type { ProviderAdapter, StreamRequest } from "./types";
import { geminiAdapter } from "./providers/gemini";
import { groqAdapter } from "./providers/groq";
import { openrouterAdapter } from "./providers/openrouter";

/**
 * Wires up concrete provider adapters behind a uniform async-generator
 * interface. The streaming route calls `callProvider(name, opts)` and gets
 * back a uniform stream regardless of which provider was picked.
 */

const adapters: Map<Provider, ProviderAdapter> = new Map();

export function registerProvider(adapter: ProviderAdapter): void {
  if (adapters.has(adapter.name)) {
    throw new Error(`Provider already registered: ${adapter.name}`);
  }
  adapters.set(adapter.name, adapter);
}

export function getProviderAdapter(provider: Provider): ProviderAdapter {
  const adapter = adapters.get(provider);
  if (!adapter) {
    throw new Error(`no_adapter_registered: ${provider}`);
  }
  return adapter;
}

export interface CallProviderOptions extends StreamRequest {}

export interface ProviderStreamChunk {
  text: string;
}

/**
 * Convenience wrapper used by the streaming route.
 * Returns an async iterable of `{ text }` chunks (uniform shape so the
 * route doesn't need to know about the provider's response format).
 */
export async function callProvider(
  provider: Provider,
  opts: CallProviderOptions,
): Promise<AsyncIterable<ProviderStreamChunk>> {
  const adapter = getProviderAdapter(provider);
  const gen = adapter.stream(opts);
  return (async function* () {
    for await (const text of gen) {
      yield { text };
    }
  })();
}

// ----- Self-register on module load -----
// Each adapter file exports a singleton; we register here so they're
// available as soon as this module is imported.
registerProvider(geminiAdapter);
registerProvider(groqAdapter);
registerProvider(openrouterAdapter);

export { geminiAdapter, groqAdapter, openrouterAdapter };
