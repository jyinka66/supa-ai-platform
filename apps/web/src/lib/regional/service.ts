// Regional service — auto-detection, config, pricing, tax, legal routing.
//
// The spec: "Regional auto-detection — user's region detected from IP, browser,
// and locale." + "Regional playbook — every region is configured from a template." +
// "Regional pricing — purchasing power parity where appropriate." +
// "Regional tax — local tax rules applied automatically." +
// "Regional legal — local legal documents served automatically."

import { db } from "@supa/db";
import { regionalConfig, regionalPricing } from "@supa/db/schema";
import { eq, and } from "drizzle-orm";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export interface RegionalConfig {
  regionCode: string;
  displayName: string;
  defaultLocale: string;
  defaultCurrency: string;
  defaultTimezone: string;
  taxRule: string;
  taxRate: number;
  legalJurisdiction: string;
  supportHours: Record<string, string>;
  supportLanguages: string[];
  paymentMethods: string[];
  dataResidency: string;
  active: boolean;
}

export interface RegionalPricingInfo {
  regionCode: string;
  plan: string;
  priceUsd: number;
  localCurrency: string;
  localPrice: number;
  pppFactor: number;
}

// ───────────────────────────────────────────────
// IP → region detection (simplified prefix matching).
// Real impl uses MaxMind GeoLite2.
// ───────────────────────────────────────────────

const IP_PREFIX_TO_REGION: Array<{ prefix: string; region: string }> = [
  // US.
  { prefix: "23.", region: "us" }, { prefix: "24.", region: "us" }, { prefix: "50.", region: "us" },
  { prefix: "73.", region: "us" }, { prefix: "104.", region: "us" }, { prefix: "108.", region: "us" },
  { prefix: "142.", region: "us" }, { prefix: "162.", region: "us" },
  // EU.
  { prefix: "2.", region: "eu" }, { prefix: "5.", region: "eu" }, { prefix: "25.", region: "eu" },
  { prefix: "51.", region: "eu" }, { prefix: "57.", region: "eu" }, { prefix: "62.", region: "eu" },
  { prefix: "77.", region: "eu" }, { prefix: "78.", region: "eu" }, { prefix: "79.", region: "eu" },
  { prefix: "80.", region: "eu" }, { prefix: "81.", region: "eu" }, { prefix: "82.", region: "eu" },
  { prefix: "83.", region: "eu" }, { prefix: "84.", region: "eu" }, { prefix: "85.", region: "eu" },
  { prefix: "86.", region: "eu" }, { prefix: "87.", region: "eu" }, { prefix: "88.", region: "eu" },
  { prefix: "89.", region: "eu" }, { prefix: "91.", region: "eu" }, { prefix: "92.", region: "eu" },
  { prefix: "93.", region: "eu" }, { prefix: "94.", region: "eu" }, { prefix: "95.", region: "eu" },
  // UK.
  { prefix: "31.", region: "uk" },
  // APAC.
  { prefix: "1.", region: "apac" }, { prefix: "14.", region: "apac" }, { prefix: "27.", region: "apac" },
  { prefix: "36.", region: "apac" }, { prefix: "49.", region: "apac" }, { prefix: "58.", region: "apac" },
  { prefix: "59.", region: "apac" }, { prefix: "60.", region: "apac" }, { prefix: "61.", region: "apac" },
  { prefix: "101.", region: "apac" }, { prefix: "103.", region: "apac" }, { prefix: "106.", region: "apac" },
  { prefix: "110.", region: "apac" }, { prefix: "111.", region: "apac" }, { prefix: "112.", region: "apac" },
  { prefix: "113.", region: "apac" }, { prefix: "114.", region: "apac" }, { prefix: "115.", region: "apac" },
  { prefix: "116.", region: "apac" }, { prefix: "117.", region: "apac" }, { prefix: "118.", region: "apac" },
  { prefix: "119.", region: "apac" }, { prefix: "120.", region: "apac" }, { prefix: "121.", region: "apac" },
  { prefix: "122.", region: "apac" }, { prefix: "123.", region: "apac" }, { prefix: "124.", region: "apac" },
  { prefix: "125.", region: "apac" }, { prefix: "126.", region: "apac" }, { prefix: "133.", region: "apac" },
  // Africa.
  { prefix: "41.", region: "af" }, { prefix: "102.", region: "af" }, { prefix: "105.", region: "af" },
  { prefix: "154.", region: "af" }, { prefix: "196.", region: "af" }, { prefix: "197.", region: "af" },
  // South America.
  { prefix: "177.", region: "sa" }, { prefix: "179.", region: "sa" }, { prefix: "181.", region: "sa" },
  { prefix: "186.", region: "sa" }, { prefix: "187.", region: "sa" }, { prefix: "189.", region: "sa" },
  { prefix: "190.", region: "sa" }, { prefix: "191.", region: "sa" }, { prefix: "200.", region: "sa" },
];

const LOCALE_TO_REGION: Record<string, string> = {
  en: "us", en_GB: "uk", en_US: "us",
  fr: "eu", de: "eu", es: "sa", pt: "sa", it: "eu", nl: "eu",
  ar: "af", sw: "af", ha: "af", yo: "af",
  ja: "apac", ko: "apac", zh: "apac", hi: "apac",
  th: "apac", vi: "apac", id: "apac", ms: "apac",
  tr: "eu", ru: "eu", pl: "eu", uk: "eu",
  fa: "af", he: "af", ur: "af",
};

export function detectRegionFromIp(ip: string): string {
  for (const { prefix, region } of IP_PREFIX_TO_REGION) {
    if (ip.startsWith(prefix)) return region;
  }
  return "us";
}

export function detectRegionFromLocale(acceptLanguage: string | null): string {
  if (!acceptLanguage) return "us";
  const firstLang = acceptLanguage.split(",")[0]?.trim().split(";")[0]?.replace("-", "_") ?? "";
  return LOCALE_TO_REGION[firstLang] ?? LOCALE_TO_REGION[firstLang.split("_")[0] ?? ""] ?? "us";
}

export function detectRegion(ip?: string | null, acceptLanguage?: string | null): string {
  if (ip) {
    const region = detectRegionFromIp(ip);
    if (region !== "us") return region;
    if (acceptLanguage) {
      const localeRegion = detectRegionFromLocale(acceptLanguage);
      if (localeRegion !== "us") return localeRegion;
    }
    return region;
  }
  if (acceptLanguage) return detectRegionFromLocale(acceptLanguage);
  return "us";
}

// ───────────────────────────────────────────────
// Regional config lookup.
// ───────────────────────────────────────────────

export async function getRegionalConfig(regionCode: string): Promise<RegionalConfig | null> {
  const rows = await db.select().from(regionalConfig).where(eq(regionalConfig.regionCode, regionCode)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    regionCode: row.regionCode,
    displayName: row.displayName,
    defaultLocale: row.defaultLocale,
    defaultCurrency: row.defaultCurrency,
    defaultTimezone: row.defaultTimezone,
    taxRule: row.taxRule,
    taxRate: Number(row.taxRate),
    legalJurisdiction: row.legalJurisdiction,
    supportHours: (row.supportHours as Record<string, string>) ?? {},
    supportLanguages: row.supportLanguages ?? [],
    paymentMethods: row.paymentMethods ?? [],
    dataResidency: row.dataResidency,
    active: row.active,
  };
}

export async function listRegions(): Promise<RegionalConfig[]> {
  const rows = await db.select().from(regionalConfig).orderBy(regionalConfig.regionCode);
  return rows.map((row) => ({
    regionCode: row.regionCode,
    displayName: row.displayName,
    defaultLocale: row.defaultLocale,
    defaultCurrency: row.defaultCurrency,
    defaultTimezone: row.defaultTimezone,
    taxRule: row.taxRule,
    taxRate: Number(row.taxRate),
    legalJurisdiction: row.legalJurisdiction,
    supportHours: (row.supportHours as Record<string, string>) ?? {},
    supportLanguages: row.supportLanguages ?? [],
    paymentMethods: row.paymentMethods ?? [],
    dataResidency: row.dataResidency,
    active: row.active,
  }));
}

// ───────────────────────────────────────────────
// Regional pricing (PPP).
// ───────────────────────────────────────────────

export async function getRegionalPricing(regionCode: string, plan: string): Promise<RegionalPricingInfo | null> {
  const rows = await db
    .select()
    .from(regionalPricing)
    .where(and(eq(regionalPricing.regionCode, regionCode), eq(regionalPricing.plan, plan), eq(regionalPricing.active, true)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    regionCode: row.regionCode,
    plan: row.plan,
    priceUsd: Number(row.priceUsd),
    localCurrency: row.localCurrency,
    localPrice: Number(row.localPrice),
    pppFactor: Number(row.pppFactor),
  };
}

export async function computeRegionalPrice(
  regionCode: string,
  plan: string,
): Promise<{ localPrice: number; localCurrency: string; taxRate: number; totalWithTax: number } | null> {
  const pricing = await getRegionalPricing(regionCode, plan);
  if (!pricing) return null;
  const config = await getRegionalConfig(regionCode);
  const taxRate = config?.taxRate ?? 0;
  return {
    localPrice: pricing.localPrice,
    localCurrency: pricing.localCurrency,
    taxRate,
    totalWithTax: pricing.localPrice * (1 + taxRate),
  };
}

// ───────────────────────────────────────────────
// Support hours.
// ───────────────────────────────────────────────

export async function isSupportAvailable(regionCode: string, now: Date = new Date()): Promise<boolean> {
  const config = await getRegionalConfig(regionCode);
  if (!config) return false;
  const supportHours = config.supportHours;
  if (Object.keys(supportHours).length === 0) return false;
  const day = now.toLocaleDateString("en", { weekday: "short" }).toLowerCase();
  const hours = supportHours[day];
  if (!hours) return false;
  const [start, end] = hours.split("-");
  if (!start || !end) return false;
  const startHour = parseInt(start.split(":")[0] ?? "0", 10);
  const endHour = parseInt(end.split(":")[0] ?? "0", 10);
  const currentHour = now.getHours();
  return currentHour >= startHour && currentHour < endHour;
}
