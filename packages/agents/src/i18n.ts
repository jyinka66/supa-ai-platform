// i18n loader + interpolator for @supa/agents.
//
// SPRINT 4 RULE: no hardcoded strings. Every user-facing string lives in
// locale files (`locales/{locale}/agents.json`). The code references keys
// (e.g. "approval.needed"), not English text. The UI layer resolves keys
// to the user's locale at render time.
//
// This module provides:
//   - loadMessages(locale) — load the agents message bundle for a locale.
//     Falls back to English if the locale is missing or a key is absent
//     (the English bundle is the canonical key set — every locale mirrors it).
//   - t(key, params?) — resolve a key to a string, with ICU-style {placeholder}
//     interpolation. Returns the key itself if not found (so missing keys
//     are visible in the UI, not silently empty).
//   - AgentMessageKey — a union type of all known keys (type-safe `t()` calls).
//
// INTERPOLATION: ICU-style {placeholder} substitution. Supports {name} →
// params.name. No plural/gender/select (the agents module's strings are
// simple parameter substitution; complex ICU is overkill here). The web app's
// NextIntl handles the full ICU spec for app-level strings; this module is the
// agents-package-local minimal interpolator for strings that live WITH the
// package (template names, approval messages, budget alerts, etc.).
//
// EVERY LOCALE MIRRORS THE ENGLISH KEY SET: the English bundle is the
// canonical set. A locale missing a key falls back to English for that key
// (the `t()` function checks the locale bundle first, then English). A locale
// with EXTRA keys not in English is a configuration error (the extra keys are
// ignored — the English set is the contract).

import enMessages from "../locales/en/agents.json" with { type: "json" };

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

/** The canonical key set (derived from the English bundle). */
export type AgentMessageKey = keyof typeof enMessages;

/** Supported locales (mirrors apps/web's LOCALES). */
export type AgentLocale = "en" | "ar" | "fr" | "es" | "de" | "pt" | "zh" | "ja" | "ko" | "hi";

/** A message bundle: key → string. */
export type AgentMessageBundle = Record<AgentMessageKey, string>;

/** Interpolation params: {placeholder} → value. */
export type InterpolationParams = Record<string, string | number>;

// ───────────────────────────────────────────────
// Message cache — loaded once per locale, cached for the process lifetime.
// ───────────────────────────────────────────────

const messageCache = new Map<AgentLocale, AgentMessageBundle>();
const loadingPromises = new Map<AgentLocale, Promise<AgentMessageBundle>>();

// The English bundle is always available (imported statically above).
messageCache.set("en", enMessages as AgentMessageBundle);

/**
 * Load the agents message bundle for a locale. Caches for the process
 * lifetime. Falls back to English for missing keys (the English bundle is
 * the canonical key set; every locale mirrors it).
 */
export async function loadMessages(locale: AgentLocale): Promise<AgentMessageBundle> {
  // Fast path: already cached.
  const cached = messageCache.get(locale);
  if (cached) return cached;

  // Already loading? Await the existing promise (dedup concurrent loads).
  const loading = loadingPromises.get(locale);
  if (loading) return loading;

  // English is the canonical set — return directly (already cached above).
  if (locale === "en") return enMessages as AgentMessageBundle;

  // Load the locale bundle dynamically.
  const promise = (async () => {
    try {
      const mod = await import(`../locales/${locale}/agents.json`);
      const localeBundle = mod.default ?? mod;
      // Merge: start with English (the canonical key set), override with
      // the locale's translations. Missing keys fall back to English.
      const merged = { ...(enMessages as AgentMessageBundle), ...localeBundle };
      messageCache.set(locale, merged);
      return merged;
    } catch {
      // Locale file missing — fall back to English entirely.
      const en = enMessages as AgentMessageBundle;
      messageCache.set(locale, en);
      return en;
    }
  })();

  loadingPromises.set(locale, promise);
  return promise;
}

// ───────────────────────────────────────────────
// t() — resolve a key to a string, with ICU-style interpolation
// ───────────────────────────────────────────────

/** The English bundle (the canonical key set + fallback). */
const englishBundle = enMessages as AgentMessageBundle;

/**
 * ICU-style {placeholder} interpolation. Replaces `{name}` with
 * `params.name`. Unknown placeholders are left as-is (so missing params are
 * visible in the UI, not silently dropped).
 *
 * No plural/gender/select — the agents module's strings are simple
 * parameter substitution. The web app's NextIntl handles the full ICU spec
 * for app-level strings; this is the package-local minimal interpolator.
 */
function interpolate(template: string, params?: InterpolationParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = params[key];
    return value != null ? String(value) : match;
  });
}

/**
 * Resolve a message key to a string. If the key is not in the bundle,
 * return the key itself (so missing keys are visible in the UI, not
 * silently empty — a missing key is a bug to fix, not a silent failure).
 *
 * Pass a `bundle` from `loadMessages(locale)` to resolve in the user's
 * locale. Without a bundle, resolves in English (the canonical set).
 *
 * `params` interpolates {placeholder} in the resolved string.
 */
export function t(
  key: AgentMessageKey,
  params?: InterpolationParams,
  bundle?: AgentMessageBundle,
): string {
  const template = bundle?.[key] ?? englishBundle[key] ?? key;
  return interpolate(template, params);
}

/**
 * Synchronous English-only resolve. Use in contexts where the locale is
 * unknown or the async loadMessages is impractical (e.g. server-side logs,
 * error messages). The UI layer should use `loadMessages(locale)` + `t()`
 * for user-facing strings.
 */
export function tEn(key: AgentMessageKey, params?: InterpolationParams): string {
  return t(key, params);
}

// ───────────────────────────────────────────────
// Key-set validation — every locale mirrors the English key set
// ───────────────────────────────────────────────

/**
 * Validate that a locale bundle has the same key set as English. Returns
 * `{ missing, extra }` — missing keys will fall back to English (handled by
 * the merge in loadMessages); extra keys are a configuration error (ignored,
 * but reported here so a CI check can catch them).
 *
 * Used by the test suite to assert every locale file mirrors the English
 * key set. A locale with missing keys is partially broken (English fallback
 * for those keys); a locale with extra keys is a configuration error (the
 * English set is the contract).
 */
export function validateLocaleBundle(
  bundle: Record<string, string>,
): { missing: string[]; extra: string[] } {
  const enKeys = new Set(Object.keys(englishBundle));
  const localeKeys = new Set(Object.keys(bundle));
  const missing = [...enKeys].filter((k) => !localeKeys.has(k));
  const extra = [...localeKeys].filter((k) => !enKeys.has(k));
  return { missing, extra };
}

/**
 * The canonical English key set (for the test suite + CI check).
 */
export const CANONICAL_KEYS = Object.keys(englishBundle) as AgentMessageKey[];
