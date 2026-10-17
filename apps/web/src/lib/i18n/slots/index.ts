import { LOCALES, DEFAULT_LOCALE, isLocale, type Locale } from "../config";

/**
 * Slot files — per-locale JSON with prompt-facing strings.
 *
 * Translators edit these files directly; they never touch prompt logic.
 * The slots are filled into prompts via `{{slotName}}` template syntax
 * by `fillSlots()` in `lib/chat/assemble-prompt.ts`.
 *
 * Slot keys are shared across all locales. Missing keys fall back to English.
 *
 * @example
 *   const slots = await loadSlots("es");
 *   // slots.greeting → "Esto es lo que encontré:"
 *   // slots.error → "Encontré un error..."
 */

export type SlotKey =
  | "greeting"
  | "disclaimer"
  | "followUp"
  | "clarify"
  | "summarizing"
  | "translating"
  | "writing"
  | "coding"
  | "planning"
  | "error"
  | "rateLimited"
  | "budgetExceeded";

export type PromptSlots = Record<SlotKey, string>;

// In-memory cache — slot files are static, loaded once per process.
const cache = new Map<string, PromptSlots>();

/**
 * Loads the slot file for a locale, with English fallback.
 *
 * Missing keys in a non-English locale are filled from the English file
 * so the prompt always renders completely (no raw `{{slotName}}` leaking).
 *
 * @example
 *   const slots = await loadSlots("es");
 *   const greeting = slots.greeting; // "Esto es lo que encontré:"
 */
export async function loadSlots(locale: string): Promise<PromptSlots> {
  const safeLocale: Locale = isLocale(locale) ? locale : DEFAULT_LOCALE;

  // Check cache.
  const cached = cache.get(safeLocale);
  if (cached) return cached;

  // Load the locale's slots.
  const localeSlots = await loadSlotFile(safeLocale);

  // Load English as the fallback for missing keys.
  let fallback: PromptSlots | null = null;
  if (safeLocale !== DEFAULT_LOCALE) {
    fallback = await loadSlotFile(DEFAULT_LOCALE) as PromptSlots;
  }

  // Merge — locale overrides English, English fills gaps.
  const merged: PromptSlots = {
    ...(fallback ?? {}),
    ...localeSlots,
  } as PromptSlots;

  cache.set(safeLocale, merged);
  return merged;
}

/**
 * Loads a single slot file from `./<locale>.json`.
 * Returns an empty record if the file doesn't exist (caller handles fallback).
 */
async function loadSlotFile(locale: Locale): Promise<Partial<PromptSlots>> {
  try {
    const mod = await import(`./${locale}.json`);
    return (mod.default ?? mod) as Partial<PromptSlots>;
  } catch {
    return {};
  }
}

/**
 * Returns a single slot for a locale, with English fallback.
 *
 * @example
 *   const greeting = await getSlot("es", "greeting");
 *   // → "Esto es lo que encontré:"
 */
export async function getSlot(locale: string, key: SlotKey): Promise<string> {
  const slots = await loadSlots(locale);
  return slots[key] ?? "";
}

/**
 * Pre-loads all locale slots into the cache.
 * Call on server boot to avoid first-request latency.
 */
export async function preloadAllSlots(): Promise<void> {
  await Promise.all(LOCALES.map((locale) => loadSlots(locale)));
}
