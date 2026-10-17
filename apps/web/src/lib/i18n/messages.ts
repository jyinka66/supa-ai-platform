import type { Locale } from "./config";

/**
 * Load NextIntl messages for a locale.
 * Messages live in `src/messages/{locale}.json` — checked into the repo.
 */
export async function getMessages(locale: Locale): Promise<Record<string, unknown>> {
  try {
    const mod = await import(`../../messages/${locale}.json`);
    return mod.default ?? mod;
  } catch {
    // Fallback to English if the requested locale is missing.
    const mod = await import(`../../messages/en.json`);
    return mod.default ?? mod;
  }
}

export type Messages = Awaited<ReturnType<typeof getMessages>>;
