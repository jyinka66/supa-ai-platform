// Locale-aware formatting — dates, numbers, currencies, addresses.
//
// The spec: "Locale-specific formatting — dates, numbers, currencies, addresses,
// phone numbers, names formatted per locale." + "Everything is region-aware."
//
// Uses the Intl API (built into Node.js + all modern browsers) — no external
// dependency. The Intl formatter is cached per (locale, options) for performance
// (constructing an Intl.DateTimeFormat is ~100x slower than reusing one).

import type { Locale } from "@/lib/i18n/config";

// ───────────────────────────────────────────────
// Formatter cache (Intl formatters are expensive to construct).
// ───────────────────────────────────────────────

const dateTimeCache = new Map<string, Intl.DateTimeFormat>();
const numberCache = new Map<string, Intl.NumberFormat>();

function getDateTimeFormatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}:${JSON.stringify(options)}`;
  let fmt = dateTimeCache.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, options);
    dateTimeCache.set(key, fmt);
  }
  return fmt;
}

function getNumberFormatter(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}:${JSON.stringify(options)}`;
  let fmt = numberCache.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat(locale, options);
    numberCache.set(key, fmt);
  }
  return fmt;
}

// ───────────────────────────────────────────────
// Date formatting
// ───────────────────────────────────────────────

/** Format a date for display (e.g. "6 Oct 2026"). */
export function formatDate(date: Date | string | number, locale: Locale | string = "en"): string {
  const d = typeof date === "string" || typeof date === "number" ? new Date(date) : date;
  return getDateTimeFormatter(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(d);
}

/** Format a date + time for display (e.g. "6 Oct 2026, 14:30"). */
export function formatDateTime(date: Date | string | number, locale: Locale | string = "en"): string {
  const d = typeof date === "string" || typeof date === "number" ? new Date(date) : date;
  return getDateTimeFormatter(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

/** Format a relative time (e.g. "3 hours ago", "in 2 days"). */
export function formatRelativeTime(date: Date | string | number, locale: Locale | string = "en"): string {
  const d = typeof date === "string" || typeof date === "number" ? new Date(date) : date;
  const diffMs = d.getTime() - Date.now();
  const diffSec = Math.round(diffMs / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });

  const divisions: Array<{ amount: number; unit: Intl.RelativeTimeFormatUnit }> = [
    { amount: 60, unit: "second" },
    { amount: 60, unit: "minute" },
    { amount: 24, unit: "hour" },
    { amount: 7, unit: "day" },
    { amount: 4.34524, unit: "week" },
    { amount: 12, unit: "month" },
    { amount: Number.POSITIVE_INFINITY, unit: "year" },
  ];

  let duration = diffSec;
  for (const division of divisions) {
    if (Math.abs(duration) < division.amount) {
      return rtf.format(Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }
  return rtf.format(Math.round(duration), "year");
}

// ───────────────────────────────────────────────
// Number formatting
// ───────────────────────────────────────────────

/** Format a number (e.g. "1,234.56" in en, "1.234,56" in de). */
export function formatNumber(value: number, locale: Locale | string = "en"): string {
  return getNumberFormatter(locale, {}).format(value);
}

/** Format a number as a percentage (e.g. "50%" in en, "50 %" in de). */
export function formatPercent(value: number, locale: Locale | string = "en"): string {
  return getNumberFormatter(locale, {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value);
}

/** Format a byte count (e.g. "1.5 MB"). */
export function formatBytes(bytes: number, locale: Locale | string = "en"): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${getNumberFormatter(locale, { maximumFractionDigits: 1 }).format(value)} ${units[i]}`;
}

// ───────────────────────────────────────────────
// Currency formatting
// ───────────────────────────────────────────────

/** Map of common currencies per locale (for auto-detection). */
export const LOCALE_CURRENCY: Record<string, string> = {
  en: "USD",
  fr: "EUR",
  es: "EUR",
  de: "EUR",
  pt: "EUR",
  it: "EUR",
  nl: "EUR",
  ar: "SAR",
  hi: "INR",
  zh: "CNY",
  ja: "JPY",
  ko: "KRW",
  sw: "KES",
  ha: "NGN",
  yo: "NGN",
  tr: "TRY",
  id: "IDR",
  vi: "VND",
  th: "THB",
  ru: "RUB",
  pl: "PLN",
  uk: "UAH",
  fa: "IRR",
  he: "ILS",
  ur: "PKR",
  bn: "BDT",
  ta: "INR",
  te: "INR",
  mr: "INR",
  ms: "MYR",
};

/**
 * Format a currency amount (e.g. "$12.34" in en, "12,34 €" in fr).
 *
 * @param amount — the amount in the currency's major unit (e.g. dollars, not cents).
 * @param currency — the ISO 4217 currency code (e.g. 'USD', 'EUR'). Defaults to the locale's currency.
 * @param locale — the locale for formatting.
 */
export function formatCurrency(
  amount: number,
  currency?: string,
  locale: Locale | string = "en",
): string {
  const ccy = currency ?? LOCALE_CURRENCY[locale] ?? "USD";
  return getNumberFormatter(locale, {
    style: "currency",
    currency: ccy,
  }).format(amount);
}

// ───────────────────────────────────────────────
// Address + phone formatting (stub — real impl uses libphonenumber)
// ───────────────────────────────────────────────

/**
 * Format a phone number for display. Stub — the real impl uses
 * libphonenumber-js for per-region formatting (e.g. +1 555-123-4567 for US,
 * +33 1 23 45 67 89 for FR).
 */
export function formatPhone(phone: string, _locale: Locale | string = "en"): string {
  // Stub: return as-is. Real impl: parse + format via libphonenumber.
  return phone;
}

// ───────────────────────────────────────────────
// Pluralization (Intl.PluralRules)
// ───────────────────────────────────────────────

/**
 * Get the plural category for a count (e.g. "one", "few", "many", "other").
 *
 * Usage (with i18n messages):
 *   const plural = getPlural(count, locale); // "one" | "few" | "many" | "other"
 *   const message = messages.items[plural]; // e.g. { one: "1 item", other: "{{count}} items" }
 */
export function getPlural(count: number, locale: Locale | string = "en"): string {
  return new Intl.PluralRules(locale).select(count);
}

/**
 * Format a count with a pluralized label.
 *
 * Usage:
 *   formatPlural(1, { one: "1 item", other: "{{count}} items" }, "en") → "1 item"
 *   formatPlural(5, { one: "1 item", other: "{{count}} items" }, "en") → "5 items"
 */
export function formatPlural(
  count: number,
  labels: { one: string; other: string; few?: string; many?: string },
  locale: Locale | string = "en",
): string {
  const category = getPlural(count, locale);
  const label = (labels as Record<string, string>)[category] ?? labels.other;
  return label.replace("{{count}}", formatNumber(count, locale));
}

// ───────────────────────────────────────────────
// Timezone-aware formatting
// ───────────────────────────────────────────────

/**
 * Format a date in a specific timezone (e.g. "6 Oct 2026, 14:30 WAT" for Africa/Lagos).
 *
 * @param date — the date (stored in UTC).
 * @param timezone — the IANA timezone (e.g. 'Africa/Lagos', 'America/New_York').
 * @param locale — the locale for formatting.
 */
export function formatDateTimeTz(
  date: Date | string | number,
  timezone: string,
  locale: Locale | string = "en",
): string {
  const d = typeof date === "string" || typeof date === "number" ? new Date(date) : date;
  return getDateTimeFormatter(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
    timeZoneName: "short",
  }).format(d);
}
