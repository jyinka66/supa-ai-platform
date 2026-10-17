import { PostHog } from "posthog-js";

const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const host = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";

let client: PostHog | null = null;

/**
 * Browser PostHog client. Returns a no-op-ish stub when the env key is missing
 * (e.g. in local dev or test) so feature flags and capture calls don't crash.
 */
export function getPostHog(): PostHog {
  if (client) return client;
  if (!key) {
    // Lazy-create a stub that swallows all calls when no API key is configured.
    client = new Proxy({} as PostHog, {
      get() {
        return () => undefined;
      },
    }) as PostHog;
    return client;
  }
  // posthog-js is a singleton — use init() instead of constructor.
  // We cast through unknown because the PostHog type from posthog-js is the
  // singleton instance, not a class.
  const ph = (require("posthog-js") as { init: (k: string, opts: unknown) => PostHog }).init(key, {
    api_host: host,
    autocapture: false,
  });
  client = ph;
  return client;
}

export const posthog = getPostHog();
