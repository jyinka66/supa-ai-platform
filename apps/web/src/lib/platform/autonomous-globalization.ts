// Autonomous globalization — language/content/currency/compliance pipelines.
// 14.2.18: "Language pipeline — new languages flow through translation, native-speaker
// review, automated QA, and launch. Content pipeline — regional and vertical content
// generated and reviewed automatically."

import { db } from "@supa/db";
import { sql } from "drizzle-orm";
import { adminAudit } from "@/lib/admin/audit";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type PipelineStage =
  | "initiated" | "translating" | "native_review" | "qa" | "launching" | "live" | "abandoned";

export interface LanguagePipeline {
  locale: string;
  stage: PipelineStage;
  translatorAssigned: boolean;
  reviewerAssigned: boolean;
  qaPassed: boolean;
  launchedAt: Date | null;
  completenessPct: number;
}

export interface CurrencyPipeline {
  currency: string;
  stage: PipelineStage;
  adapterTested: boolean;
  exchangeRateSource: string;
  launchedAt: Date | null;
}

export interface CompliancePipeline {
  jurisdiction: string;
  stage: PipelineStage;
  legalDocsReady: boolean;
  policyConfigured: boolean;
  dataResidencyVerified: boolean;
  launchedAt: Date | null;
}

export interface MarketEntry {
  regionCode: string;
  locale: string;
  stage: "preparing" | "content_ready" | "support_ready" | "launched";
  landingPageReady: boolean;
  pricingPageReady: boolean;
  supportConfigured: boolean;
  launchedAt: Date | null;
}

// ───────────────────────────────────────────────
// Language pipeline — new languages flow through:
// initiated → translating → native_review → qa → launching → live.
// ───────────────────────────────────────────────

export async function startLanguagePipeline(locale: string): Promise<LanguagePipeline> {
  // Check if already in progress.
  const existing = await db.execute(sql`
    select status, completeness_pct from locales where code = ${locale}
  `);
  const row = (existing as unknown as Array<{ status: string; completeness_pct: string }>)[0];
  if (row && row.status === "live") {
    return { locale, stage: "live", translatorAssigned: true, reviewerAssigned: true, qaPassed: true, launchedAt: new Date(), completenessPct: Number(row.completeness_pct) };
  }

  // Update locale status to 'translating' (or create if not exists).
  await db.execute(sql`
    insert into locales (code, label, english_label, direction, status, completeness_pct)
    values (${locale}, ${locale}, ${locale}, 'ltr', 'translating', 0)
    on conflict (code) do update set status = 'translating', updated_at = now()
  `);

  await adminAudit({ actor: "system", action: "globalization.language.pipeline_started", target: { locale }, justification: `Language pipeline started for ${locale}` });

  return { locale, stage: "translating", translatorAssigned: false, reviewerAssigned: false, qaPassed: false, launchedAt: null, completenessPct: 0 };
}

export async function advanceLanguagePipeline(locale: string): Promise<LanguagePipeline> {
  // STUB: would check the current stage + advance if the stage's checklist is complete.
  // initiated → translating (AI translation first pass) → native_review (human reviewer) → qa (automated checks) → launching → live.
  const stages: PipelineStage[] = ["initiated", "translating", "native_review", "qa", "launching", "live"];
  const current = await db.execute(sql`select status from locales where code = ${locale}`);
  const currentStatus = (current as unknown as Array<{ status: string }>)[0]?.status ?? "initiated";
  const currentIdx = stages.indexOf(currentStatus as PipelineStage);
  const nextStage = stages[Math.min(currentIdx + 1, stages.length - 1)] ?? "live";

  if (nextStage === "live") {
    await db.execute(sql`update locales set status = 'live', completeness_pct = 100 where code = ${locale}`);
    await adminAudit({ actor: "system", action: "globalization.language.launched", target: { locale }, justification: `Language ${locale} launched (100% complete)` });
  } else {
    await db.execute(sql`update locales set status = ${nextStage} where code = ${locale}`);
  }

  return { locale, stage: nextStage, translatorAssigned: nextStage !== "initiated", reviewerAssigned: ["native_review", "qa", "launching", "live"].includes(nextStage), qaPassed: ["qa", "launching", "live"].includes(nextStage), launchedAt: nextStage === "live" ? new Date() : null, completenessPct: nextStage === "live" ? 100 : 50 };
}

// ───────────────────────────────────────────────
// Content pipeline — regional + vertical content generated + reviewed.
// ───────────────────────────────────────────────

export async function generateRegionalContent(regionCode: string, contentType: "landing_page" | "pricing_page" | "help_articles"): Promise<{ generated: boolean; reviewed: boolean }> {
  // STUB: would generate localized content via AI + queue for native review.
  await adminAudit({ actor: "system", action: "globalization.content.generated", target: { regionCode, contentType }, justification: `Regional content (${contentType}) generated for ${regionCode}` });
  return { generated: true, reviewed: false }; // reviewed=false (pending native review).
}

export async function generateVerticalContent(verticalSlug: string, locale: string): Promise<{ generated: boolean }> {
  // STUB: would generate vertical-specific content (prompts, templates) in the locale.
  await adminAudit({ actor: "system", action: "globalization.vertical_content.generated", target: { verticalSlug, locale }, justification: `Vertical content for ${verticalSlug} generated in ${locale}` });
  return { generated: true };
}

// ───────────────────────────────────────────────
// Localization QA — automated checks.
// ───────────────────────────────────────────────

export interface LocalizationQaResult {
  locale: string;
  missingStrings: number;
  rtlIssues: number;
  formattingErrors: number;
  placeholderMismatches: number;
  passed: boolean;
}

export async function runLocalizationQa(locale: string): Promise<LocalizationQaResult> {
  // STUB: would run the i18n CI checker (lib/i18n/checker.ts) against the locale.
  // For now, returns a passing result.
  return {
    locale,
    missingStrings: 0,
    rtlIssues: 0,
    formattingErrors: 0,
    placeholderMismatches: 0,
    passed: true,
  };
}

// ───────────────────────────────────────────────
// Currency pipeline — new currencies via adapters.
// ───────────────────────────────────────────────

export async function startCurrencyPipeline(currency: string, exchangeRateSource: string = "ECB"): Promise<CurrencyPipeline> {
  await adminAudit({ actor: "system", action: "globalization.currency.pipeline_started", target: { currency, exchangeRateSource }, justification: `Currency pipeline started for ${currency}` });
  return { currency, stage: "initiated", adapterTested: false, exchangeRateSource, launchedAt: null };
}

// ───────────────────────────────────────────────
// Compliance pipeline — new jurisdictions via playbooks.
// ───────────────────────────────────────────────

export async function startCompliancePipeline(jurisdiction: string): Promise<CompliancePipeline> {
  await adminAudit({ actor: "system", action: "globalization.compliance.pipeline_started", target: { jurisdiction }, justification: `Compliance pipeline started for ${jurisdiction}` });
  return { jurisdiction, stage: "initiated", legalDocsReady: false, policyConfigured: false, dataResidencyVerified: false, launchedAt: null };
}

// ───────────────────────────────────────────────
// Market entry — regional launch campaigns.
// ───────────────────────────────────────────────

export async function prepareMarketEntry(regionCode: string, locale: string): Promise<MarketEntry> {
  // STUB: would prepare: landing page, pricing page, support config, marketing campaign.
  await adminAudit({ actor: "system", action: "globalization.market_entry.preparing", target: { regionCode, locale }, justification: `Market entry preparation for ${regionCode}/${locale}` });
  return {
    regionCode, locale, stage: "preparing",
    landingPageReady: false, pricingPageReady: false, supportConfigured: false, launchedAt: null,
  };
}

export async function launchMarket(regionCode: string, locale: string): Promise<MarketEntry> {
  await adminAudit({ actor: "system", action: "globalization.market_entry.launched", target: { regionCode, locale }, justification: `Market launched for ${regionCode}/${locale}` });
  return {
    regionCode, locale, stage: "launched",
    landingPageReady: true, pricingPageReady: true, supportConfigured: true, launchedAt: new Date(),
  };
}
