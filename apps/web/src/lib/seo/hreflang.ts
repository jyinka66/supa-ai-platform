// hreflang verification — ensures all locale pairs are bidirectional.
//
// The spec: "hreflang — every locale paired with every other, verified."
//
// For a page available in locales [en, fr, ar], the hreflang must include:
//   - en → fr, en → ar (from en's perspective).
//   - fr → en, fr → ar (from fr's perspective).
//   - ar → en, ar → fr (from ar's perspective).
//   - x-default → en (the default locale).
//
// Missing or one-directional hreflang causes Google to pick the wrong locale
// for users (e.g. showing the English page to a French user). This checker
// catches those issues.

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export interface HreflangEntry {
  locale: string;
  url: string;
  alternates: string[]; // other locales this page claims to have.
}

export interface HreflangViolation {
  type: "missing_alternate" | "one_directional" | "missing_x_default" | "invalid_locale";
  page: string;
  detail: string;
}

// ───────────────────────────────────────────────
// Verification
// ───────────────────────────────────────────────

/**
 * Verify that a set of hreflang entries are complete + bidirectional.
 *
 * For each page (grouped by canonical path), every locale must list every
 * other locale as an alternate, AND the alternates must be bidirectional
 * (if en lists fr, fr must list en).
 *
 * @param entries — all hreflang entries across all locales for a page.
 * @param defaultLocale — the default locale (for x-default verification).
 * @param supportedLocales — all supported locales (for completeness checking).
 */
export function verifyHreflang(
  entries: HreflangEntry[],
  defaultLocale: string = "en",
  supportedLocales: string[] = ["en", "fr", "ar", "es", "de", "pt", "zh", "ja", "ko", "hi"],
): HreflangViolation[] {
  const violations: HreflangViolation[] = [];
  const localeSet = new Set(entries.map((e) => e.locale));

  // 1. Check that each entry lists all other locales.
  for (const entry of entries) {
    const expectedAlternates = entries
      .filter((e) => e.locale !== entry.locale)
      .map((e) => e.locale);

    for (const expected of expectedAlternates) {
      if (!entry.alternates.includes(expected)) {
        violations.push({
          type: "missing_alternate",
          page: entry.url,
          detail: `Locale "${entry.locale}" is missing hreflang alternate for "${expected}"`,
        });
      }
    }
  }

  // 2. Check bidirectionality (if en lists fr, fr must list en).
  for (const entry of entries) {
    for (const alt of entry.alternates) {
      // Validate the alternate locale is known (x-default is a special pseudo-locale).
      if (alt !== "x-default" && !supportedLocales.includes(alt)) {
        violations.push({
          type: "invalid_locale",
          page: entry.url,
          detail: `Invalid hreflang locale "${alt}" (not in supported locales)`,
        });
        continue;
      }

      // x-default doesn't need a bidirectional link (it's the fallback, not a locale entry).
      if (alt === "x-default") continue;

      // Find the alternate entry.
      const altEntry = entries.find((e) => e.locale === alt);
      if (!altEntry) {
        violations.push({
          type: "one_directional",
          page: entry.url,
          detail: `Locale "${entry.locale}" links to "${alt}" but no "${alt}" entry exists`,
        });
        continue;
      }

      // Check the reverse link.
      if (!altEntry.alternates.includes(entry.locale)) {
        violations.push({
          type: "one_directional",
          page: entry.url,
          detail: `"${entry.locale}" → "${alt}" but "${alt}" does not link back to "${entry.locale}"`,
        });
      }
    }
  }

  // 3. Check x-default is present (the default locale should have it).
  const defaultEntry = entries.find((e) => e.locale === defaultLocale);
  if (defaultEntry && !defaultEntry.alternates.includes("x-default")) {
    violations.push({
      type: "missing_x_default",
      page: defaultEntry.url,
      detail: `Default locale "${defaultLocale}" is missing hreflang="x-default"`,
    });
  }

  // 4. Check completeness (all supported locales should be present for a fully-localized page).
  for (const locale of supportedLocales) {
    if (!localeSet.has(locale) && localeSet.size > 0) {
      // Only flag if the page has SOME locales but not all (incomplete localization).
      violations.push({
        type: "missing_alternate",
        page: entries[0]?.url ?? "",
        detail: `Supported locale "${locale}" is missing from hreflang entries`,
      });
    }
  }

  return violations;
}

/**
 * Generate the hreflang alternates for a page across all locales.
 *
 * Given a base URL + path + the list of locales the page is available in,
 * returns the alternates map (for the Next.js metadata alternates.languages).
 *
 *   generateHreflang("https://supa.ai", "/blog/my-post", ["en", "fr", "ar"])
 *   → {
 *       en: "https://supa.ai/en/blog/my-post",
 *       fr: "https://supa.ai/fr/blog/my-post",
 *       ar: "https://supa.ai/ar/blog/my-post",
 *       "x-default": "https://supa.ai/en/blog/my-post",
 *     }
 */
export function generateHreflang(
  baseUrl: string,
  path: string,
  locales: string[],
  defaultLocale: string = "en",
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const locale of locales) {
    result[locale] = `${baseUrl}/${locale}${path === "/" ? "" : path}`;
  }
  result["x-default"] = `${baseUrl}/${defaultLocale}${path === "/" ? "" : path}`;
  return result;
}
