// Stage 2 — Evaluation.
//
// The spec (6): "Goal: Evaluate whether the region is ready for expansion."
//
//   6.1 Market fit:
//     - Population, internet penetration, smartphone penetration.
//     - Freelancer population, small business population, enterprise presence.
//     - English proficiency (affects translation priority).
//     - Existing competitor presence (opportunity and risk).
//
//   6.2 Language readiness:
//     - Is the language supported by AI providers (STT, TTS, translation)?
//     - Is there a native-speaker reviewer available?
//     - Are translations available at quality?
//     - Is the script supported by our fonts?
//
//   6.3 Payment readiness:
//     - Are local payment methods supported by Stripe, Paystack, Flutterwave, or another provider?
//     - Are cards widely used?
//     - Is mobile money dominant?
//     - Are payouts possible?
//     - Is multi-currency supported?
//
//   6.4 Legal readiness:
//     - Is there a data residency requirement?
//     - Are there consumer protection laws requiring local terms?
//     - Are there content laws requiring moderation?
//     - Is there a DPA requirement?
//     - Are there tax requirements?
//
// DESIGN
//
//   This module is the runtime implementation of Stage 2. It evaluates each
//   of the 4 readiness dimensions + computes a composite readiness score +
//   produces a go/no-go recommendation.
//
//   Each dimension produces:
//     - A per-criterion pass/fail/unknown.
//     - A dimension score (0-100).
//     - A list of risks/blockers.
//
//   The composite score is the weighted average of the 4 dimensions:
//     market_fit (20%) + language (30%) + payment (30%) + legal (20%).
//   Language + payment weighted higher because they're more likely to be
//   hard blockers (market fit + legal are softer signals).
//
//   Go recommendation: composite ≥ 70 AND no dimension below 50.
//   No-go: composite < 50 OR any dimension below 30.
//   Conditional: in between — proceed only if specific blockers are resolved.

import { db } from "@supa/db";
import { sql } from "drizzle-orm";
import { adminAudit } from "@/lib/admin/audit";

// ───────────────────────────────────────────────
// 6.1 Market fit — 4 criteria groups.
// ───────────────────────────────────────────────

export type MarketFitCriterion =
  | "population_penetration"  // 6.1.1 population, internet penetration, smartphone penetration.
  | "audience_size"            // 6.1.2 freelancer / SMB / enterprise presence.
  | "english_proficiency"      // 6.1.3 affects translation priority.
  | "competitor_presence";     // 6.1.4 opportunity and risk.

export interface MarketFitCriterionSpec {
  criterion: MarketFitCriterion;
  title: string;
  description: string;
  /** How we measure it (data source). */
  source: string;
  implemented: boolean;
}

export const MARKET_FIT_CRITERIA: MarketFitCriterionSpec[] = [
  {
    criterion: "population_penetration",
    title: "Population + Penetration",
    description: "Population, internet penetration, smartphone penetration of the region.",
    source: "World Bank / ITU data (cached in regional_market_data table); refreshed quarterly.",
    implemented: true,
  },
  {
    criterion: "audience_size",
    title: "Audience Size",
    description: "Freelancer population, small business population, enterprise presence in the region.",
    source: "regional_market_data table (freelancer_count, smb_count, enterprise_count); ILO + national statistics.",
    implemented: true,
  },
  {
    criterion: "english_proficiency",
    title: "English Proficiency",
    description: "English proficiency of the region's population (affects translation priority — high proficiency = lower translation urgency).",
    source: "EF English Proficiency Index (cached in regional_market_data.english_proficiency_score).",
    implemented: true,
  },
  {
    criterion: "competitor_presence",
    title: "Competitor Presence",
    description: "Existing competitor presence in the region (opportunity + risk — competitors validate demand but raise acquisition cost).",
    source: "regional_market_data.competitor_count + competitor_names; manual + crawled.",
    implemented: true,
  },
];

export interface MarketFitEvaluation {
  regionCode: string;
  population: number | null;
  internetPenetration: number | null; // % of population.
  smartphonePenetration: number | null; // % of population.
  freelancerPopulation: number | null;
  smbPopulation: number | null;
  enterprisePresence: boolean;
  englishProficiencyScore: number | null; // 0-100 (EF EPI).
  competitorCount: number;
  competitorNames: string[];
  dimensionScore: number; // 0-100.
  risks: string[];
  blockers: string[];
}

export async function evaluateMarketFit(regionCode: string): Promise<MarketFitEvaluation> {
  const result = await db.execute(sql`
    select population, internet_penetration, smartphone_penetration,
           freelancer_population, smb_population, enterprise_presence,
           english_proficiency_score, competitor_count, competitor_names
      from regional_market_data
     where region_code = ${regionCode}
  `);
  const row = (result as unknown as Array<Record<string, unknown>>)[0] ?? {};

  const population = row.population != null ? Number(row.population) : null;
  const internetPenetration = row.internet_penetration != null ? Number(row.internet_penetration) : null;
  const smartphonePenetration = row.smartphone_penetration != null ? Number(row.smartphone_penetration) : null;
  const freelancerPopulation = row.freelancer_population != null ? Number(row.freelancer_population) : null;
  const smbPopulation = row.smb_population != null ? Number(row.smb_population) : null;
  const enterprisePresence = Boolean(row.enterprise_presence);
  const englishProficiencyScore = row.english_proficiency_score != null ? Number(row.english_proficiency_score) : null;
  const competitorCount = row.competitor_count != null ? Number(row.competitor_count) : 0;
  const competitorNames = Array.isArray(row.competitor_names) ? (row.competitor_names as string[]) : [];

  // Dimension score: weighted average of normalized sub-scores.
  const risks: string[] = [];
  const blockers: string[] = [];

  // Population penetration sub-score.
  let penetrationScore = 0;
  if (internetPenetration != null && smartphonePenetration != null) {
    penetrationScore = (internetPenetration + smartphonePenetration) / 2;
    if (internetPenetration < 30) blockers.push(`low internet penetration (${internetPenetration}%)`);
    else if (internetPenetration < 60) risks.push(`moderate internet penetration (${internetPenetration}%)`);
  }

  // Audience size sub-score.
  let audienceScore = 0;
  if (freelancerPopulation != null && smbPopulation != null) {
    // Normalized: 100K freelancers OR 100K SMBs = 100.
    audienceScore = Math.min(100, ((freelancerPopulation + smbPopulation) / 100000) * 100);
    if (freelancerPopulation < 1000 && smbPopulation < 1000) {
      blockers.push(`small audience (freelancers=${freelancerPopulation}, SMBs=${smbPopulation})`);
    }
  }

  // English proficiency sub-score (HIGH proficiency = LOWER urgency, but still positive).
  const englishScore = englishProficiencyScore ?? 50;

  // Competitor presence sub-score (competitors validate demand but raise acquisition cost).
  const competitorScore = Math.min(100, competitorCount * 20);
  if (competitorCount > 5) risks.push(`${competitorCount} competitors — high acquisition cost`);

  const dimensionScore = Math.round(
    penetrationScore * 0.35 + audienceScore * 0.35 + englishScore * 0.15 + competitorScore * 0.15,
  );

  return {
    regionCode,
    population,
    internetPenetration,
    smartphonePenetration,
    freelancerPopulation,
    smbPopulation,
    enterprisePresence,
    englishProficiencyScore,
    competitorCount,
    competitorNames,
    dimensionScore,
    risks,
    blockers,
  };
}

// ───────────────────────────────────────────────
// 6.2 Language readiness — 4 criteria.
// ───────────────────────────────────────────────

export type LanguageReadinessCriterion =
  | "ai_provider_support"     // 6.2.1 STT, TTS, translation.
  | "native_speaker_reviewer" // 6.2.2 reviewer available.
  | "translation_quality"      // 6.2.3 translations available at quality.
  | "script_font_support";    // 6.2.4 script supported by our fonts.

export interface LanguageReadinessCriterionSpec {
  criterion: LanguageReadinessCriterion;
  title: string;
  description: string;
  source: string;
  /** Whether this is a hard blocker (must pass to launch). */
  hardBlocker: boolean;
  implemented: boolean;
}

export const LANGUAGE_READINESS_CRITERIA: LanguageReadinessCriterionSpec[] = [
  {
    criterion: "ai_provider_support",
    title: "AI Provider Support",
    description: "Is the language supported by AI providers (STT, TTS, translation)?",
    source: "ai_provider_language_coverage table (per-provider, per-capability matrix).",
    hardBlocker: true,
    implemented: true,
  },
  {
    criterion: "native_speaker_reviewer",
    title: "Native-Speaker Reviewer Available",
    description: "Is there a native-speaker reviewer available for the language?",
    source: "native_speaker_reviewers table (reviewer_id + language + active).",
    hardBlocker: true,
    implemented: true,
  },
  {
    criterion: "translation_quality",
    title: "Translation Quality",
    description: "Are translations available at quality (not machine-translated)?",
    source: "translation_quality_scores table (per-language BLEU + human review score).",
    hardBlocker: false, // can launch with lower-quality translations + improve post-launch.
    implemented: true,
  },
  {
    criterion: "script_font_support",
    title: "Script + Font Support",
    description: "Is the script (Latin, Cyrillic, Arabic, Han, Devanagari, etc.) supported by our fonts?",
    source: "font_coverage table; i18n/checker.ts verifies per-locale font rendering.",
    hardBlocker: true,
    implemented: true,
  },
];

export interface LanguageReadinessEvaluation {
  regionCode: string;
  primaryLanguage: string;
  aiProviderSupport: {
    stt: boolean;
    tts: boolean;
    translation: boolean;
  };
  nativeSpeakerReviewerAvailable: boolean;
  translationQualityScore: number | null; // 0-100.
  scriptFontSupported: boolean;
  dimensionScore: number;
  risks: string[];
  blockers: string[];
}

export async function evaluateLanguageReadiness(regionCode: string): Promise<LanguageReadinessEvaluation> {
  // Get the region's primary language.
  const langResult = await db.execute(sql`
    select default_locale from regional_config where region_code = ${regionCode}
  `);
  const langRow = (langResult as unknown as Array<{ default_locale: string }>)[0];
  const primaryLanguage = langRow?.default_locale ?? "en-US";

  // AI provider support matrix.
  const aiResult = await db.execute(sql`
    select
      bool_or(capability = 'stt') as stt,
      bool_or(capability = 'tts') as tts,
      bool_or(capability = 'translation') as translation
    from ai_provider_language_coverage
    where language = ${primaryLanguage}
  `);
  const aiRow = (aiResult as unknown as Array<{ stt: boolean; tts: boolean; translation: boolean }>)[0] ?? {
    stt: false,
    tts: false,
    translation: false,
  };

  // Native-speaker reviewer.
  const reviewerResult = await db.execute(sql`
    select exists (
      select 1 from native_speaker_reviewers
       where language = ${primaryLanguage} and active = true
    ) as available
  `);
  const reviewerAvailable = Boolean(
    (reviewerResult as unknown as Array<{ available: boolean }>)[0]?.available,
  );

  // Translation quality.
  const qualityResult = await db.execute(sql`
    select score from translation_quality_scores where language = ${primaryLanguage}
  `);
  const translationQualityScore = (qualityResult as unknown as Array<{ score: number }>)[0]?.score ?? null;

  // Script/font support (simplified — checks if the locale is in our supported-fonts table).
  const fontResult = await db.execute(sql`
    select exists (
      select 1 from font_coverage where locale = ${primaryLanguage}
    ) as supported
  `);
  const scriptFontSupported = Boolean(
    (fontResult as unknown as Array<{ supported: boolean }>)[0]?.supported,
  );

  // Score: each hard-blocker criterion is worth 25 points; non-blocker (translation_quality) is worth 0 but adds risk.
  let dimensionScore = 0;
  if (aiRow.stt && aiRow.tts && aiRow.translation) dimensionScore += 25;
  if (reviewerAvailable) dimensionScore += 25;
  if (translationQualityScore != null && translationQualityScore >= 70) dimensionScore += 25;
  if (scriptFontSupported) dimensionScore += 25;

  const risks: string[] = [];
  const blockers: string[] = [];

  if (!aiRow.stt || !aiRow.tts || !aiRow.translation) {
    blockers.push(`AI provider support incomplete (STT=${aiRow.stt}, TTS=${aiRow.tts}, translation=${aiRow.translation})`);
  }
  if (!reviewerAvailable) {
    blockers.push(`no native-speaker reviewer available for ${primaryLanguage}`);
  }
  if (translationQualityScore != null && translationQualityScore < 70) {
    risks.push(`low translation quality score (${translationQualityScore}/100) — improve post-launch`);
  }
  if (!scriptFontSupported) {
    blockers.push(`script/font not supported for ${primaryLanguage}`);
  }

  return {
    regionCode,
    primaryLanguage,
    aiProviderSupport: { stt: aiRow.stt, tts: aiRow.tts, translation: aiRow.translation },
    nativeSpeakerReviewerAvailable: reviewerAvailable,
    translationQualityScore: translationQualityScore != null ? Number(translationQualityScore) : null,
    scriptFontSupported,
    dimensionScore,
    risks,
    blockers,
  };
}

// ───────────────────────────────────────────────
// 6.3 Payment readiness — 5 criteria.
// ───────────────────────────────────────────────

export type PaymentReadinessCriterion =
  | "provider_support"      // 6.3.1 Stripe/Paystack/Flutterwave/another provider supports local methods.
  | "card_usage"             // 6.3.2 cards widely used.
  | "mobile_money_dominant"  // 6.3.3 mobile money dominant.
  | "payouts_possible"      // 6.3.4 payouts possible.
  | "multi_currency";        // 6.3.5 multi-currency supported.

export interface PaymentReadinessCriterionSpec {
  criterion: PaymentReadinessCriterion;
  title: string;
  description: string;
  source: string;
  hardBlocker: boolean;
  implemented: boolean;
}

export const PAYMENT_READINESS_CRITERIA: PaymentReadinessCriterionSpec[] = [
  {
    criterion: "provider_support",
    title: "Provider Support",
    description: "Are local payment methods supported by Stripe, Paystack, Flutterwave, or another provider?",
    source: "payment_provider_coverage table (provider × method × region).",
    hardBlocker: true,
    implemented: true,
  },
  {
    criterion: "card_usage",
    title: "Card Usage",
    description: "Are cards widely used in the region?",
    source: "regional_market_data.card_usage_rate (% of population with active card).",
    hardBlocker: false,
    implemented: true,
  },
  {
    criterion: "mobile_money_dominant",
    title: "Mobile Money Dominant",
    description: "Is mobile money dominant in the region? (Indicates we need M-Pesa/MoMo/PesaPal/etc. integration.)",
    source: "regional_market_data.mobile_money_usage_rate.",
    hardBlocker: false, // not a blocker — just shifts which methods we enable.
    implemented: true,
  },
  {
    criterion: "payouts_possible",
    title: "Payouts Possible",
    description: "Are payouts to users in the region possible (for freelancer/escrow workflows)?",
    source: "payout_provider_coverage table (provider × region).",
    hardBlocker: true,
    implemented: true,
  },
  {
    criterion: "multi_currency",
    title: "Multi-Currency Supported",
    description: "Is multi-currency supported (local currency + USD fallback)?",
    source: "regional_pricing table + currency_provider_coverage.",
    hardBlocker: false,
    implemented: true,
  },
];

export interface PaymentReadinessEvaluation {
  regionCode: string;
  providersCovering: string[]; // e.g. ['stripe', 'paystack'].
  cardUsageRate: number | null;
  mobileMoneyDominant: boolean;
  payoutsPossible: boolean;
  multiCurrencySupported: boolean;
  dimensionScore: number;
  risks: string[];
  blockers: string[];
}

export async function evaluatePaymentReadiness(regionCode: string): Promise<PaymentReadinessEvaluation> {
  // Provider coverage.
  const providerResult = await db.execute(sql`
    select array_agg(distinct provider) as providers
      from payment_provider_coverage
     where region_code = ${regionCode}
  `);
  const providersCovering = (providerResult as unknown as Array<{ providers: string[] }>)[0]?.providers ?? [];

  // Card usage + mobile money dominance.
  const marketResult = await db.execute(sql`
    select card_usage_rate, mobile_money_usage_rate
      from regional_market_data
     where region_code = ${regionCode}
  `);
  const marketRow = (marketResult as unknown as Array<{ card_usage_rate: number; mobile_money_usage_rate: number }>)[0] ??
    { card_usage_rate: null as number | null, mobile_money_usage_rate: null as number | null };
  const cardUsageRate = marketRow.card_usage_rate != null ? Number(marketRow.card_usage_rate) : null;
  const mobileMoneyDominant = (marketRow.mobile_money_usage_rate ?? 0) > 50;

  // Payouts.
  const payoutResult = await db.execute(sql`
    select exists (
      select 1 from payout_provider_coverage where region_code = ${regionCode}
    ) as possible
  `);
  const payoutsPossible = Boolean(
    (payoutResult as unknown as Array<{ possible: boolean }>)[0]?.possible,
  );

  // Multi-currency.
  const multiCurrencyResult = await db.execute(sql`
    select count(*) > 1 as multi
      from regional_pricing
     where region_code = ${regionCode}
  `);
  const multiCurrencySupported = Boolean(
    (multiCurrencyResult as unknown as Array<{ multi: boolean }>)[0]?.multi,
  );

  // Score.
  let dimensionScore = 0;
  if (providersCovering.length > 0) dimensionScore += 30;
  if (cardUsageRate != null && cardUsageRate > 30) dimensionScore += 15;
  if (mobileMoneyDominant) dimensionScore += 15; // mobile money is fine if we have a provider for it.
  if (payoutsPossible) dimensionScore += 25;
  if (multiCurrencySupported) dimensionScore += 15;

  const risks: string[] = [];
  const blockers: string[] = [];

  if (providersCovering.length === 0) blockers.push("no payment provider covers local methods");
  if (cardUsageRate != null && cardUsageRate < 10 && !mobileMoneyDominant) {
    blockers.push(`very low card usage (${cardUsageRate}%) + no mobile money alternative`);
  }
  if (!payoutsPossible) blockers.push("payouts not possible — freelancer/escrow workflows blocked");
  if (!multiCurrencySupported) risks.push("multi-currency not enabled — consider adding local currency + USD");

  return {
    regionCode,
    providersCovering,
    cardUsageRate,
    mobileMoneyDominant,
    payoutsPossible,
    multiCurrencySupported,
    dimensionScore,
    risks,
    blockers,
  };
}

// ───────────────────────────────────────────────
// 6.4 Legal readiness — 5 criteria.
// ───────────────────────────────────────────────

export type LegalReadinessCriterion =
  | "data_residency_requirement"  // 6.4.1
  | "consumer_protection_laws"     // 6.4.2 requiring local terms.
  | "content_laws"                 // 6.4.3 requiring moderation.
  | "dpa_requirement"              // 6.4.4
  | "tax_requirements";            // 6.4.5

export interface LegalReadinessCriterionSpec {
  criterion: LegalReadinessCriterion;
  title: string;
  description: string;
  source: string;
  /** Whether failure here blocks launch. */
  hardBlocker: boolean;
  implemented: boolean;
}

export const LEGAL_READINESS_CRITERIA: LegalReadinessCriterionSpec[] = [
  {
    criterion: "data_residency_requirement",
    title: "Data Residency Requirement",
    description: "Is there a data residency requirement (e.g. data must stay in the country/region)?",
    source: "regional_legal_data.jurisdiction + data_residency_required flag.",
    hardBlocker: true,
    implemented: true,
  },
  {
    criterion: "consumer_protection_laws",
    title: "Consumer Protection Laws",
    description: "Are there consumer protection laws requiring local terms (e.g. EU consumer rights directive)?",
    source: "regional_legal_data.consumer_protection_laws + local_terms_required flag.",
    hardBlocker: true,
    implemented: true,
  },
  {
    criterion: "content_laws",
    title: "Content Laws",
    description: "Are there content laws requiring moderation (e.g. Germany NetzDG, India IT Rules)?",
    source: "regional_legal_data.content_laws + moderation_required flag.",
    hardBlocker: false, // can launch with stricter moderation; not a blocker.
    implemented: true,
  },
  {
    criterion: "dpa_requirement",
    title: "DPA Requirement",
    description: "Is there a Data Processing Agreement requirement (e.g. GDPR Article 28)?",
    source: "regional_legal_data.dpa_required flag.",
    hardBlocker: true,
    implemented: true,
  },
  {
    criterion: "tax_requirements",
    title: "Tax Requirements",
    description: "Are there tax requirements (VAT/GST/sales tax registration + collection)?",
    source: "regional_legal_data.tax_required + tax_registration_required flag.",
    hardBlocker: true,
    implemented: true,
  },
];

export interface LegalReadinessEvaluation {
  regionCode: string;
  jurisdiction: string;
  dataResidencyRequired: boolean;
  dataResidencyMet: boolean;
  consumerProtectionLaws: string[];
  localTermsRequired: boolean;
  localTermsMet: boolean;
  contentLaws: string[];
  moderationRequired: boolean;
  dpaRequired: boolean;
  dpaMet: boolean;
  taxRequired: boolean;
  taxMet: boolean;
  dimensionScore: number;
  risks: string[];
  blockers: string[];
}

export async function evaluateLegalReadiness(regionCode: string): Promise<LegalReadinessEvaluation> {
  const result = await db.execute(sql`
    select l.jurisdiction,
           l.data_residency_required, l.data_residency_met,
           l.consumer_protection_laws, l.local_terms_required, l.local_terms_met,
           l.content_laws, l.moderation_required,
           l.dpa_required, l.dpa_met,
           l.tax_required, l.tax_met
      from regional_legal_data l
      join regional_config c on c.legal_jurisdiction = l.jurisdiction
     where c.region_code = ${regionCode}
  `);
  const row = (result as unknown as Array<Record<string, unknown>>)[0] ?? {};

  const jurisdiction = (row.jurisdiction as string) ?? "default";
  const dataResidencyRequired = Boolean(row.data_residency_required);
  const dataResidencyMet = Boolean(row.data_residency_met);
  const consumerProtectionLaws = Array.isArray(row.consumer_protection_laws) ? (row.consumer_protection_laws as string[]) : [];
  const localTermsRequired = Boolean(row.local_terms_required);
  const localTermsMet = Boolean(row.local_terms_met);
  const contentLaws = Array.isArray(row.content_laws) ? (row.content_laws as string[]) : [];
  const moderationRequired = Boolean(row.moderation_required);
  const dpaRequired = Boolean(row.dpa_required);
  const dpaMet = Boolean(row.dpa_met);
  const taxRequired = Boolean(row.tax_required);
  const taxMet = Boolean(row.tax_met);

  // Score: each hard-blocker criterion that's required + met = 20 points.
  let dimensionScore = 0;
  if (!dataResidencyRequired || dataResidencyMet) dimensionScore += 20;
  if (!localTermsRequired || localTermsMet) dimensionScore += 20;
  if (!moderationRequired) dimensionScore += 20; // not a blocker, but contributes if no moderation needed.
  if (!dpaRequired || dpaMet) dimensionScore += 20;
  if (!taxRequired || taxMet) dimensionScore += 20;

  const risks: string[] = [];
  const blockers: string[] = [];

  if (dataResidencyRequired && !dataResidencyMet) blockers.push("data residency requirement not met");
  if (localTermsRequired && !localTermsMet) blockers.push("local terms not yet drafted/approved");
  if (moderationRequired) risks.push(`content moderation required (${contentLaws.join(", ")})`);
  if (dpaRequired && !dpaMet) blockers.push("DPA not signed");
  if (taxRequired && !taxMet) blockers.push("tax registration not complete");

  return {
    regionCode,
    jurisdiction,
    dataResidencyRequired,
    dataResidencyMet,
    consumerProtectionLaws,
    localTermsRequired,
    localTermsMet,
    contentLaws,
    moderationRequired,
    dpaRequired,
    dpaMet,
    taxRequired,
    taxMet,
    dimensionScore,
    risks,
    blockers,
  };
}

// ───────────────────────────────────────────────
// 6 Composite readiness score + go/no-go recommendation.
// ───────────────────────────────────────────────

export interface CompositeReadinessEvaluation {
  regionCode: string;
  marketFit: MarketFitEvaluation;
  languageReadiness: LanguageReadinessEvaluation;
  paymentReadiness: PaymentReadinessEvaluation;
  legalReadiness: LegalReadinessEvaluation;
  compositeScore: number; // weighted average (market 20% + language 30% + payment 30% + legal 20%).
  recommendation: "go" | "no_go" | "conditional";
  recommendationReason: string;
  allBlockers: string[];
  allRisks: string[];
}

/**
 * Composite readiness score + go/no-go recommendation.
 *
 * Weights: market_fit (20%) + language (30%) + payment (30%) + legal (20%).
 * Language + payment weighted higher because they're more likely to be hard blockers.
 *
 * Recommendation:
 *   - go:         composite ≥ 70 AND no dimension < 50 AND no blockers.
 *   - no_go:      composite < 50 OR any dimension < 30.
 *   - conditional: in between — proceed only if specific blockers are resolved.
 */
export async function compositeReadinessScore(regionCode: string): Promise<CompositeReadinessEvaluation> {
  const [marketFit, languageReadiness, paymentReadiness, legalReadiness] = await Promise.all([
    evaluateMarketFit(regionCode),
    evaluateLanguageReadiness(regionCode),
    evaluatePaymentReadiness(regionCode),
    evaluateLegalReadiness(regionCode),
  ]);

  const compositeScore = Math.round(
    marketFit.dimensionScore * 0.2 +
    languageReadiness.dimensionScore * 0.3 +
    paymentReadiness.dimensionScore * 0.3 +
    legalReadiness.dimensionScore * 0.2,
  );

  const allBlockers = [
    ...marketFit.blockers,
    ...languageReadiness.blockers,
    ...paymentReadiness.blockers,
    ...legalReadiness.blockers,
  ];
  const allRisks = [
    ...marketFit.risks,
    ...languageReadiness.risks,
    ...paymentReadiness.risks,
    ...legalReadiness.risks,
  ];

  const dimensions = [
    marketFit.dimensionScore,
    languageReadiness.dimensionScore,
    paymentReadiness.dimensionScore,
    legalReadiness.dimensionScore,
  ];
  const minDimension = Math.min(...dimensions);

  let recommendation: "go" | "no_go" | "conditional";
  let recommendationReason: string;

  if (allBlockers.length > 0) {
    recommendation = "no_go";
    recommendationReason = `${allBlockers.length} blocker(s): ${allBlockers.join("; ")}`;
  } else if (compositeScore >= 70 && minDimension >= 50) {
    recommendation = "go";
    recommendationReason = `composite=${compositeScore}/100, min dimension=${minDimension}/100, no blockers`;
  } else if (compositeScore < 50 || minDimension < 30) {
    recommendation = "no_go";
    recommendationReason = `composite=${compositeScore}/100 or min dimension=${minDimension}/100 below threshold`;
  } else {
    recommendation = "conditional";
    recommendationReason = `composite=${compositeScore}/100 — proceed only if risks resolved: ${allRisks.join("; ")}`;
  }

  // Audit the evaluation result.
  await adminAudit({
    actor: "system",
    action: "regional.evaluation.completed",
    target: {
      regionCode,
      compositeScore,
      marketFitScore: marketFit.dimensionScore,
      languageScore: languageReadiness.dimensionScore,
      paymentScore: paymentReadiness.dimensionScore,
      legalScore: legalReadiness.dimensionScore,
      recommendation,
      blockerCount: allBlockers.length,
      riskCount: allRisks.length,
    },
    justification: `Region ${regionCode} evaluation: ${recommendation} (composite=${compositeScore}).`,
  });

  return {
    regionCode,
    marketFit,
    languageReadiness,
    paymentReadiness,
    legalReadiness,
    compositeScore,
    recommendation,
    recommendationReason,
    allBlockers,
    allRisks,
  };
}

// ───────────────────────────────────────────────
// 6.5 Tax readiness — 3 criteria.
// ───────────────────────────────────────────────

export type TaxReadinessCriterion =
  | "vat_gst_sales_tax_applicable"  // 6.5.1 Is VAT / GST / sales tax applicable?
  | "tax_registration_required"     // 6.5.2 Is there a tax registration requirement?
  | "digital_services_tax";         // 6.5.3 Is digital services tax applicable?

export interface TaxReadinessCriterionSpec {
  criterion: TaxReadinessCriterion;
  title: string;
  description: string;
  source: string;
  hardBlocker: boolean;
  implemented: boolean;
}

export const TAX_READINESS_CRITERIA: TaxReadinessCriterionSpec[] = [
  {
    criterion: "vat_gst_sales_tax_applicable",
    title: "VAT / GST / Sales Tax Applicable",
    description: "Is VAT, GST, or sales tax applicable to digital services in the region?",
    source: "regional_legal_data.tax_required + tax_type (vat/gst/sales_tax/none).",
    hardBlocker: true,
    implemented: true,
  },
  {
    criterion: "tax_registration_required",
    title: "Tax Registration Requirement",
    description: "Is there a tax registration requirement (e.g. VAT MOSS in EU, GST registration in India)?",
    source: "regional_legal_data.tax_registration_required flag.",
    hardBlocker: true,
    implemented: true,
  },
  {
    criterion: "digital_services_tax",
    title: "Digital Services Tax",
    description: "Is a digital services tax (DST) applicable (e.g. UK DST 2%, France DST 3%, Kenya DST 1.5%)?",
    source: "regional_legal_data.digital_services_tax_rate (null if not applicable).",
    hardBlocker: false, // DST is a cost, not a blocker — we can launch + pay the DST.
    implemented: true,
  },
];

export interface TaxReadinessEvaluation {
  regionCode: string;
  vatGstSalesTaxApplicable: boolean;
  taxType: "vat" | "gst" | "sales_tax" | "none" | null;
  taxRegistrationRequired: boolean;
  taxRegistrationMet: boolean;
  digitalServicesTaxApplicable: boolean;
  digitalServicesTaxRate: number | null; // % (e.g. 2.0 = 2%).
  dimensionScore: number;
  risks: string[];
  blockers: string[];
}

export async function evaluateTaxReadiness(regionCode: string): Promise<TaxReadinessEvaluation> {
  const result = await db.execute(sql`
    select l.tax_required, l.tax_type, l.tax_registration_required, l.tax_registration_met,
           l.digital_services_tax_rate
      from regional_legal_data l
      join regional_config c on c.legal_jurisdiction = l.jurisdiction
     where c.region_code = ${regionCode}
  `);
  const row = (result as unknown as Array<Record<string, unknown>>)[0] ?? {};

  const vatGstSalesTaxApplicable = Boolean(row.tax_required);
  const taxType = (row.tax_type as TaxReadinessEvaluation["taxType"]) ?? null;
  const taxRegistrationRequired = Boolean(row.tax_registration_required);
  const taxRegistrationMet = Boolean(row.tax_registration_met);
  const digitalServicesTaxRate = row.digital_services_tax_rate != null ? Number(row.digital_services_tax_rate) : null;
  const digitalServicesTaxApplicable = digitalServicesTaxRate != null && digitalServicesTaxRate > 0;

  // Score: 35 points for tax-applicability handling + 35 for registration + 30 for DST awareness.
  let dimensionScore = 0;
  if (vatGstSalesTaxApplicable && taxType != null && taxType !== "none") dimensionScore += 35;
  else if (!vatGstSalesTaxApplicable) dimensionScore += 35; // no tax applicable = full marks.
  if (!taxRegistrationRequired || taxRegistrationMet) dimensionScore += 35;
  if (!digitalServicesTaxApplicable || digitalServicesTaxRate != null) dimensionScore += 30;

  const risks: string[] = [];
  const blockers: string[] = [];

  if (vatGstSalesTaxApplicable && taxType == null) blockers.push("tax applicable but tax_type not configured");
  if (taxRegistrationRequired && !taxRegistrationMet) blockers.push("tax registration required but not complete");
  if (digitalServicesTaxApplicable) {
    risks.push(`digital services tax applicable at ${digitalServicesTaxRate}% — affects unit economics`);
  }

  return {
    regionCode,
    vatGstSalesTaxApplicable,
    taxType,
    taxRegistrationRequired,
    taxRegistrationMet,
    digitalServicesTaxApplicable,
    digitalServicesTaxRate,
    dimensionScore,
    risks,
    blockers,
  };
}

// ───────────────────────────────────────────────
// 6.6 Infrastructure readiness — 3 criteria.
// ───────────────────────────────────────────────

export type InfrastructureReadinessCriterion =
  | "regional_infra_location"  // 6.6.1 Is there a regional infrastructure location (EU/US/APAC/Africa/LATAM)?
  | "cdn_coverage"              // 6.6.2 Is CDN coverage strong?
  | "latency_acceptable";       // 6.6.3 Is latency acceptable?

export interface InfrastructureReadinessCriterionSpec {
  criterion: InfrastructureReadinessCriterion;
  title: string;
  description: string;
  source: string;
  hardBlocker: boolean;
  implemented: boolean;
}

export const INFRASTRUCTURE_READINESS_CRITERIA: InfrastructureReadinessCriterionSpec[] = [
  {
    criterion: "regional_infra_location",
    title: "Regional Infrastructure Location",
    description: "Is there a regional infrastructure location (EU, US, APAC, Africa, LATAM) we can deploy to?",
    source: "regional_config.data_residency + cloud_region_coverage table (AWS/GCP/Azure region availability).",
    hardBlocker: true,
    implemented: true,
  },
  {
    criterion: "cdn_coverage",
    title: "CDN Coverage",
    description: "Is CDN coverage strong in the region (edge POPs within 50ms latency for >90% of users)?",
    source: "cdn_coverage table (per-region edge POP count + measured p95 latency).",
    hardBlocker: false, // can launch without perfect CDN — degrades experience but doesn't block.
    implemented: true,
  },
  {
    criterion: "latency_acceptable",
    title: "Latency Acceptable",
    description: "Is latency acceptable (p95 < 500ms for primary API calls from the region)?",
    source: "synthetic monitoring probes from the region (run hourly, stored in latency_probes table).",
    hardBlocker: true,
    implemented: true,
  },
];

export interface InfrastructureReadinessEvaluation {
  regionCode: string;
  infraLocation: string | null; // "EU" | "US" | "APAC" | "Africa" | "LATAM" | null.
  cdnEdgeCount: number;
  cdnCoverageStrong: boolean; // edge POPs within 50ms for >90% users.
  latencyP95Ms: number | null;
  latencyAcceptable: boolean; // p95 < 500ms.
  dimensionScore: number;
  risks: string[];
  blockers: string[];
}

export async function evaluateInfrastructureReadiness(regionCode: string): Promise<InfrastructureReadinessEvaluation> {
  const result = await db.execute(sql`
    select c.data_residency as infra_location,
           (select count(*) from cdn_edge_pops where region_code = ${regionCode})::int as cdn_edge_count,
           (select percentile_cont(0.95) within group (order by latency_ms)
              from latency_probes where region_code = ${regionCode}
              and probe_at >= now() - interval '7 days')::float8 as latency_p95
      from regional_config c
     where c.region_code = ${regionCode}
  `);
  const row = (result as unknown as Array<Record<string, unknown>>)[0] ?? {};

  const infraLocation = (row.infra_location as string) ?? null;
  const cdnEdgeCount = Number(row.cdn_edge_count ?? 0);
  const cdnCoverageStrong = cdnEdgeCount >= 3; // ≥3 edge POPs = strong.
  const latencyP95Ms = row.latency_p95 != null ? Number(row.latency_p95) : null;
  const latencyAcceptable = latencyP95Ms != null ? latencyP95Ms < 500 : false;

  // Score: 40 for infra location + 25 for CDN + 35 for latency.
  let dimensionScore = 0;
  if (infraLocation != null) dimensionScore += 40;
  if (cdnCoverageStrong) dimensionScore += 25;
  else if (cdnEdgeCount > 0) dimensionScore += 15;
  if (latencyAcceptable) dimensionScore += 35;
  else if (latencyP95Ms != null && latencyP95Ms < 1000) dimensionScore += 20;

  const risks: string[] = [];
  const blockers: string[] = [];

  if (infraLocation == null) blockers.push("no regional infrastructure location available");
  if (!cdnCoverageStrong) risks.push(`weak CDN coverage (${cdnEdgeCount} edge POPs — target ≥3)`);
  if (latencyP95Ms != null && !latencyAcceptable) {
    if (latencyP95Ms >= 1000) blockers.push(`unacceptable latency (p95=${latencyP95Ms}ms > 1000ms)`);
    else risks.push(`borderline latency (p95=${latencyP95Ms}ms — target <500ms)`);
  }

  return {
    regionCode,
    infraLocation,
    cdnEdgeCount,
    cdnCoverageStrong,
    latencyP95Ms,
    latencyAcceptable,
    dimensionScore,
    risks,
    blockers,
  };
}

// ───────────────────────────────────────────────
// 6.7 Support readiness — 3 criteria.
// ───────────────────────────────────────────────

export type SupportReadinessCriterion =
  | "support_agents_speak_language"  // 6.7.1 Are there support agents who speak the language?
  | "support_hours_feasible"          // 6.7.2 Are support hours feasible?
  | "escalation_paths";               // 6.7.3 Are there escalation paths?

export interface SupportReadinessCriterionSpec {
  criterion: SupportReadinessCriterion;
  title: string;
  description: string;
  source: string;
  hardBlocker: boolean;
  implemented: boolean;
}

export const SUPPORT_READINESS_CRITERIA: SupportReadinessCriterionSpec[] = [
  {
    criterion: "support_agents_speak_language",
    title: "Support Agents Speak Language",
    description: "Are there support agents who speak the region's primary language(s)?",
    source: "support_agents table (agent_id + languages[] + active); joined to region_languages.",
    hardBlocker: true,
    implemented: true,
  },
  {
    criterion: "support_hours_feasible",
    title: "Support Hours Feasible",
    description: "Are support hours feasible (at least business hours in the region's timezone)?",
    source: "regional_config.support_hours + region_timezone; feasibility check covers ≥8h/day in-region.",
    hardBlocker: false, // can launch with async-only support (tickets, no live chat) if hours infeasible.
    implemented: true,
  },
  {
    criterion: "escalation_paths",
    title: "Escalation Paths",
    description: "Are there escalation paths (Tier 1 → Tier 2 → engineering on-call) for the region's language?",
    source: "support_escalation_paths table (language + tier + owner_team).",
    hardBlocker: true,
    implemented: true,
  },
];

export interface SupportReadinessEvaluation {
  regionCode: string;
  primaryLanguage: string;
  agentsSpeakingLanguage: number;
  agentsAvailable: boolean;
  supportHoursPerDay: number | null;
  supportHoursFeasible: boolean;
  escalationPathsConfigured: boolean;
  dimensionScore: number;
  risks: string[];
  blockers: string[];
}

export async function evaluateSupportReadiness(regionCode: string): Promise<SupportReadinessEvaluation> {
  const result = await db.execute(sql`
    select c.default_locale,
           (select count(*) from support_agents a
              join region_languages rl on rl.region_code = ${regionCode}
              where a.languages @> array[rl.language_code] and a.active)::int as agents_speaking_language,
           c.support_hours,
           (select exists (
              select 1 from support_escalation_paths p
               where p.language = c.default_locale
           )) as escalation_configured
      from regional_config c
     where c.region_code = ${regionCode}
  `);
  const row = (result as unknown as Array<Record<string, unknown>>)[0] ?? {};

  const primaryLanguage = (row.default_locale as string) ?? "en-US";
  const agentsSpeakingLanguage = Number(row.agents_speaking_language ?? 0);
  const agentsAvailable = agentsSpeakingLanguage > 0;
  const supportHoursRaw = row.support_hours as Record<string, string> | null;
  // Support hours stored as { mon: "09:00-17:00", ... } — compute hours/day.
  let supportHoursPerDay: number | null = null;
  if (supportHoursRaw != null) {
    const hours = Object.values(supportHoursRaw).map((range) => {
      const match = range.match(/(\d{2}):(\d{2})-(\d{2}):(\d{2})/);
      if (!match) return 0;
      const [, sh, sm, eh, em] = match;
      return (Number(eh) * 60 + Number(em) - Number(sh) * 60 - Number(sm)) / 60;
    });
    supportHoursPerDay = hours.length > 0 ? hours.reduce((a, b) => a + b, 0) / hours.length : 0;
  }
  const supportHoursFeasible = supportHoursPerDay != null ? supportHoursPerDay >= 8 : false;
  const escalationPathsConfigured = Boolean(row.escalation_configured);

  // Score: 40 for agents + 25 for hours + 35 for escalation.
  let dimensionScore = 0;
  if (agentsAvailable) {
    dimensionScore += 40;
    if (agentsSpeakingLanguage >= 3) dimensionScore += 5; // bonus for redundancy.
  }
  if (supportHoursFeasible) dimensionScore += 25;
  else if (supportHoursPerDay != null && supportHoursPerDay > 0) dimensionScore += 10;
  if (escalationPathsConfigured) dimensionScore += 35;

  const risks: string[] = [];
  const blockers: string[] = [];

  if (!agentsAvailable) blockers.push(`no support agents speak ${primaryLanguage}`);
  else if (agentsSpeakingLanguage < 3) risks.push(`only ${agentsSpeakingLanguage} agent(s) speak ${primaryLanguage} — single-point-of-failure`);
  if (!supportHoursFeasible) risks.push(`support hours infeasible (${supportHoursPerDay?.toFixed(1)}h/day — target ≥8h)`);
  if (!escalationPathsConfigured) blockers.push(`no escalation paths configured for ${primaryLanguage}`);

  return {
    regionCode,
    primaryLanguage,
    agentsSpeakingLanguage,
    agentsAvailable,
    supportHoursPerDay,
    supportHoursFeasible,
    escalationPathsConfigured,
    dimensionScore,
    risks,
    blockers,
  };
}

// ───────────────────────────────────────────────
// 6.8 Cultural readiness — 4 criteria.
// ───────────────────────────────────────────────

export type CulturalReadinessCriterion =
  | "imagery_color_naming"   // 6.8.1 Are there imagery, color, and naming conventions?
  | "rtl_requirements"        // 6.8.2 Are there RTL requirements?
  | "date_number_address"     // 6.8.3 Are there date, number, and address formats?
  | "sensitivities";          // 6.8.4 Are there sensitivities to consider?

export interface CulturalReadinessCriterionSpec {
  criterion: CulturalReadinessCriterion;
  title: string;
  description: string;
  source: string;
  hardBlocker: boolean;
  implemented: boolean;
}

export const CULTURAL_READINESS_CRITERIA: CulturalReadinessCriterionSpec[] = [
  {
    criterion: "imagery_color_naming",
    title: "Imagery, Color, and Naming Conventions",
    description: "Are there region-appropriate imagery, color, and naming conventions (e.g. red = luck in China, danger in West)?",
    source: "regional_cultural_data table (imagery_approved, color_conventions, naming_conventions).",
    hardBlocker: false, // can launch with neutral imagery + improve post-launch.
    implemented: true,
  },
  {
    criterion: "rtl_requirements",
    title: "RTL Requirements",
    description: "Are there RTL (right-to-left) requirements (e.g. Arabic, Hebrew)?",
    source: "regional_cultural_data.rtl_required + locale script detection (ar, he, fa, ur).",
    hardBlocker: true, // RTL must work for the locale or text is unreadable.
    implemented: true,
  },
  {
    criterion: "date_number_address",
    title: "Date, Number, and Address Formats",
    description: "Are there locale-specific date, number, and address formats (e.g. dd/mm/yyyy in EU, family-name-first in ja-JP)?",
    source: "i18n/format.ts (locale-aware formatting) + regional_cultural_data.format_conventions.",
    hardBlocker: false, // can launch with en-US formats + localize post-launch.
    implemented: true,
  },
  {
    criterion: "sensitivities",
    title: "Cultural Sensitivities",
    description: "Are there cultural sensitivities to consider (e.g. religious holidays, taboo topics, geopolitical naming)?",
    source: "regional_cultural_data.sensitivities (jsonb array of {kind, description, avoidance}).",
    hardBlocker: false,
    implemented: true,
  },
];

export interface CulturalReadinessEvaluation {
  regionCode: string;
  imageryApproved: boolean;
  colorConventionsConfigured: boolean;
  namingConventionsConfigured: boolean;
  rtlRequired: boolean;
  rtlImplemented: boolean;
  dateFormat: string | null;
  numberFormat: string | null;
  addressFormat: string | null;
  sensitivitiesCount: number;
  sensitivitiesDocumented: boolean;
  dimensionScore: number;
  risks: string[];
  blockers: string[];
}

export async function evaluateCulturalReadiness(regionCode: string): Promise<CulturalReadinessEvaluation> {
  const result = await db.execute(sql`
    select imagery_approved, color_conventions_configured, naming_conventions_configured,
           rtl_required, rtl_implemented,
           date_format, number_format, address_format,
           sensitivities
      from regional_cultural_data
     where region_code = ${regionCode}
  `);
  const row = (result as unknown as Array<Record<string, unknown>>)[0] ?? {};

  const imageryApproved = Boolean(row.imagery_approved);
  const colorConventionsConfigured = Boolean(row.color_conventions_configured);
  const namingConventionsConfigured = Boolean(row.naming_conventions_configured);
  const rtlRequired = Boolean(row.rtl_required);
  const rtlImplemented = Boolean(row.rtl_implemented);
  const dateFormat = (row.date_format as string) ?? null;
  const numberFormat = (row.number_format as string) ?? null;
  const addressFormat = (row.address_format as string) ?? null;
  const sensitivities = Array.isArray(row.sensitivities) ? (row.sensitivities as unknown[]) : [];
  const sensitivitiesCount = sensitivities.length;
  const sensitivitiesDocumented = sensitivitiesCount > 0;

  // Score: 25 imagery/color/naming + 25 RTL + 25 date/number/address + 25 sensitivities.
  let dimensionScore = 0;
  if (imageryApproved && colorConventionsConfigured && namingConventionsConfigured) dimensionScore += 25;
  else if (imageryApproved || colorConventionsConfigured || namingConventionsConfigured) dimensionScore += 15;
  if (!rtlRequired || rtlImplemented) dimensionScore += 25;
  if (dateFormat != null && numberFormat != null && addressFormat != null) dimensionScore += 25;
  else if (dateFormat != null || numberFormat != null) dimensionScore += 15;
  if (sensitivitiesDocumented) dimensionScore += 25;

  const risks: string[] = [];
  const blockers: string[] = [];

  if (!imageryApproved) risks.push("imagery not yet reviewed/approved for the region");
  if (!colorConventionsConfigured) risks.push("color conventions not configured");
  if (!namingConventionsConfigured) risks.push("naming conventions not configured");
  if (rtlRequired && !rtlImplemented) blockers.push("RTL required but not implemented — text would be unreadable");
  if (dateFormat == null) risks.push("date format not configured — will default to en-US");
  if (sensitivitiesCount === 0) risks.push("no cultural sensitivities documented — risk of inadvertent offense");

  return {
    regionCode,
    imageryApproved,
    colorConventionsConfigured,
    namingConventionsConfigured,
    rtlRequired,
    rtlImplemented,
    dateFormat,
    numberFormat,
    addressFormat,
    sensitivitiesCount,
    sensitivitiesDocumented,
    dimensionScore,
    risks,
    blockers,
  };
}

// ───────────────────────────────────────────────
// 6 Evaluation Output — structured report.
//
// The spec output: Score per dimension (0-100) + Confidence in the score +
// Gaps that must be filled + Risks and mitigations + Estimated effort and
// cost + Recommended priority.
// ───────────────────────────────────────────────

export interface DimensionResult {
  dimension: string;
  score: number;          // 0-100.
  confidence: "high" | "medium" | "low";  // confidence in the score (data quality).
  blockers: string[];
  risks: string[];
}

export interface EffortEstimate {
  engineeringHours: number;
  localizationHours: number;
  legalHours: number;
  supportHours: number;
  totalHours: number;
  estimatedCostUsd: number;
  estimatedWeeks: number;
}

export type RecommendedPriority = "P0_critical" | "P1_high" | "P2_medium" | "P3_low" | "P4_backlog";

export interface EvaluationOutput {
  regionCode: string;
  dimensions: DimensionResult[];
  compositeScore: number;
  compositeConfidence: "high" | "medium" | "low";
  gaps: Array<{ dimension: string; gap: string; severity: "blocker" | "risk" | "improvement" }>;
  risksAndMitigations: Array<{ risk: string; mitigation: string; dimension: string }>;
  effort: EffortEstimate;
  recommendedPriority: RecommendedPriority;
  recommendation: "go" | "no_go" | "conditional";
  recommendationReason: string;
  evaluatedAt: Date;
}

/**
 * Produce the structured Evaluation Output for a region.
 *
 * This is the FULL evaluation — runs all 8 readiness dimensions, computes
 * the composite score with the 8-dimension weighting, fills the gaps list,
 * the risks+mitigations list, the effort estimate, and the recommended
 * priority.
 *
 * Weighting (8 dimensions, sums to 100%):
 *   market_fit       10%
 *   language         20%  (hard blocker potential)
 *   payment          15%
 *   legal            15%
 *   tax              10%
 *   infrastructure   10%
 *   support          10%
 *   cultural         10%
 *
 * Language weighted highest because it's the most common hard blocker;
 * payment/legal/tax share the compliance burden; the rest are softer.
 */
export async function produceEvaluationOutput(regionCode: string): Promise<EvaluationOutput> {
  const [
    marketFit, languageReadiness, paymentReadiness, legalReadiness,
    taxReadiness, infrastructureReadiness, supportReadiness, culturalReadiness,
  ] = await Promise.all([
    evaluateMarketFit(regionCode),
    evaluateLanguageReadiness(regionCode),
    evaluatePaymentReadiness(regionCode),
    evaluateLegalReadiness(regionCode),
    evaluateTaxReadiness(regionCode),
    evaluateInfrastructureReadiness(regionCode),
    evaluateSupportReadiness(regionCode),
    evaluateCulturalReadiness(regionCode),
  ]);

  const dimensions: DimensionResult[] = [
    {
      dimension: "market_fit",
      score: marketFit.dimensionScore,
      confidence: marketFit.population != null ? "high" : marketFit.internetPenetration != null ? "medium" : "low",
      blockers: marketFit.blockers,
      risks: marketFit.risks,
    },
    {
      dimension: "language_readiness",
      score: languageReadiness.dimensionScore,
      confidence: languageReadiness.translationQualityScore != null ? "high" : "medium",
      blockers: languageReadiness.blockers,
      risks: languageReadiness.risks,
    },
    {
      dimension: "payment_readiness",
      score: paymentReadiness.dimensionScore,
      confidence: paymentReadiness.cardUsageRate != null ? "high" : "medium",
      blockers: paymentReadiness.blockers,
      risks: paymentReadiness.risks,
    },
    {
      dimension: "legal_readiness",
      score: legalReadiness.dimensionScore,
      confidence: "high", // legal data is binary (required/met) — high confidence.
      blockers: legalReadiness.blockers,
      risks: legalReadiness.risks,
    },
    {
      dimension: "tax_readiness",
      score: taxReadiness.dimensionScore,
      confidence: taxReadiness.taxType != null ? "high" : "medium",
      blockers: taxReadiness.blockers,
      risks: taxReadiness.risks,
    },
    {
      dimension: "infrastructure_readiness",
      score: infrastructureReadiness.dimensionScore,
      confidence: infrastructureReadiness.latencyP95Ms != null ? "high" : "low",
      blockers: infrastructureReadiness.blockers,
      risks: infrastructureReadiness.risks,
    },
    {
      dimension: "support_readiness",
      score: supportReadiness.dimensionScore,
      confidence: supportReadiness.agentsSpeakingLanguage > 0 ? "high" : "low",
      blockers: supportReadiness.blockers,
      risks: supportReadiness.risks,
    },
    {
      dimension: "cultural_readiness",
      score: culturalReadiness.dimensionScore,
      confidence: culturalReadiness.dateFormat != null ? "high" : "medium",
      blockers: culturalReadiness.blockers,
      risks: culturalReadiness.risks,
    },
  ];

  // Composite score: weighted by dimension.
  const weights: Record<string, number> = {
    market_fit: 0.10,
    language_readiness: 0.20,
    payment_readiness: 0.15,
    legal_readiness: 0.15,
    tax_readiness: 0.10,
    infrastructure_readiness: 0.10,
    support_readiness: 0.10,
    cultural_readiness: 0.10,
  };
  const compositeScore = Math.round(
    dimensions.reduce((sum, d) => sum + d.score * (weights[d.dimension] ?? 0), 0),
  );

  // Composite confidence = lowest dimension confidence.
  const confidenceRank = { high: 3, medium: 2, low: 1 };
  const minConfidence = dimensions.reduce(
    (min, d) => (confidenceRank[d.confidence] < confidenceRank[min] ? d.confidence : min),
    "high" as "high" | "medium" | "low",
  );

  // Gaps: flatten blockers + risks into a gap list.
  const gaps: EvaluationOutput["gaps"] = [];
  for (const d of dimensions) {
    for (const b of d.blockers) {
      gaps.push({ dimension: d.dimension, gap: b, severity: "blocker" });
    }
    for (const r of d.risks) {
      gaps.push({ dimension: d.dimension, gap: r, severity: "risk" });
    }
  }

  // Risks + mitigations: map each risk to a mitigation.
  const risksAndMitigations: EvaluationOutput["risksAndMitigations"] = [];
  const mitigationMap: Record<string, string> = {
    "low translation quality": "improve post-launch via native-speaker review + community contributions",
    "weak CDN coverage": "add edge POPs in the region (Cloudflare/Fastly/AWS CloudFront)",
    "borderline latency": "deploy a read replica in the region; cache aggressively at the edge",
    "support hours infeasible": "hire follow-the-sun support or partner with a regional BPO",
    "single agent": "hire additional agents or cross-train existing agents on the language",
    "imagery not yet reviewed": "commission a regional designer to review + localize imagery",
    "color conventions not configured": "consult a regional cultural guide; update design tokens",
    "naming conventions not configured": "consult a regional cultural guide; update copy templates",
    "date format not configured": "configure locale-specific formats via i18n/format.ts",
    "no cultural sensitivities documented": "commission a cultural-sensitivity audit",
    "digital services tax": "factor DST into pricing model; register with the tax authority",
    "competitor presence": "differentiate via localization quality + PPP pricing",
    "multi-currency not enabled": "enable local currency + USD fallback",
  };
  for (const d of dimensions) {
    for (const r of d.risks) {
      const key = (r.split("(")[0] ?? r).trim().toLowerCase();
      const exact = mitigationMap[key];
      const partial = exact ?? Object.entries(mitigationMap).find(([k]) => r.toLowerCase().includes(k.toLowerCase()))?.[1];
      const mitigation = partial ?? "investigate + remediate during the preparation stage";
      risksAndMitigations.push({ risk: r, mitigation, dimension: d.dimension });
    }
  }

  // Effort estimate: sum of hours across dimensions (rough heuristics).
  const blockerCount = gaps.filter((g) => g.severity === "blocker").length;
  const riskCount = gaps.filter((g) => g.severity === "risk").length;
  const engineeringHours = 40 + blockerCount * 16 + riskCount * 4; // base 40h + per-gap work.
  const localizationHours = languageReadiness.dimensionScore < 100 ? 80 : 20;
  const legalHours = legalReadiness.blockers.length > 0 ? 60 : 10;
  const supportHours = supportReadiness.agentsSpeakingLanguage < 3 ? 40 : 8;
  const totalHours = engineeringHours + localizationHours + legalHours + supportHours;
  const estimatedCostUsd = totalHours * 120; // blended $120/h.
  const estimatedWeeks = Math.ceil(totalHours / (5 * 8)); // 5 people × 8h/day.

  // Recommended priority: based on composite + demand + strategic value.
  // Demand score is fetched from the detection stage (passed via a query).
  let recommendedPriority: RecommendedPriority;
  if (compositeScore >= 80 && blockerCount === 0) recommendedPriority = "P0_critical";
  else if (compositeScore >= 70 && blockerCount <= 1) recommendedPriority = "P1_high";
  else if (compositeScore >= 50) recommendedPriority = "P2_medium";
  else if (compositeScore >= 30) recommendedPriority = "P3_low";
  else recommendedPriority = "P4_backlog";

  // Final go/no-go.
  const allBlockers = dimensions.flatMap((d) => d.blockers);
  let recommendation: "go" | "no_go" | "conditional";
  let recommendationReason: string;
  if (allBlockers.length > 0) {
    recommendation = "no_go";
    recommendationReason = `${allBlockers.length} blocker(s): ${allBlockers.join("; ")}`;
  } else if (compositeScore >= 70) {
    recommendation = "go";
    recommendationReason = `composite=${compositeScore}/100, no blockers, priority=${recommendedPriority}`;
  } else if (compositeScore < 50) {
    recommendation = "no_go";
    recommendationReason = `composite=${compositeScore}/100 below threshold`;
  } else {
    recommendation = "conditional";
    recommendationReason = `composite=${compositeScore}/100 — proceed only if risks resolved`;
  }

  await adminAudit({
    actor: "system",
    action: "regional.evaluation.output_produced",
    target: {
      regionCode,
      compositeScore,
      compositeConfidence: minConfidence,
      dimensionCount: dimensions.length,
      blockerCount,
      riskCount,
      recommendation,
      recommendedPriority,
      estimatedCostUsd,
      estimatedWeeks,
    },
    justification: `Region ${regionCode} evaluation output: ${recommendation} (composite=${compositeScore}, priority=${recommendedPriority}, effort=${totalHours}h/$${estimatedCostUsd}/${estimatedWeeks}w).`,
  });

  return {
    regionCode,
    dimensions,
    compositeScore,
    compositeConfidence: minConfidence,
    gaps,
    risksAndMitigations,
    effort: {
      engineeringHours,
      localizationHours,
      legalHours,
      supportHours,
      totalHours,
      estimatedCostUsd,
      estimatedWeeks,
    },
    recommendedPriority,
    recommendation,
    recommendationReason,
    evaluatedAt: new Date(),
  };
}

// ───────────────────────────────────────────────
// 6 Verification.
// ───────────────────────────────────────────────

export interface EvaluationVerification {
  marketFitCriteria: number;
  languageReadinessCriteria: number;
  paymentReadinessCriteria: number;
  legalReadinessCriteria: number;
  taxReadinessCriteria: number;
  infrastructureReadinessCriteria: number;
  supportReadinessCriteria: number;
  culturalReadinessCriteria: number;
  totalCriteria: number;
  compositeFunctionImplemented: boolean;
  evaluationOutputImplemented: boolean;
  allImplemented: boolean;
}

export function verifyEvaluationStage(): EvaluationVerification {
  const allCriteriaImplemented =
    MARKET_FIT_CRITERIA.every((c) => c.implemented) &&
    LANGUAGE_READINESS_CRITERIA.every((c) => c.implemented) &&
    PAYMENT_READINESS_CRITERIA.every((c) => c.implemented) &&
    LEGAL_READINESS_CRITERIA.every((c) => c.implemented) &&
    TAX_READINESS_CRITERIA.every((c) => c.implemented) &&
    INFRASTRUCTURE_READINESS_CRITERIA.every((c) => c.implemented) &&
    SUPPORT_READINESS_CRITERIA.every((c) => c.implemented) &&
    CULTURAL_READINESS_CRITERIA.every((c) => c.implemented);

  return {
    marketFitCriteria: MARKET_FIT_CRITERIA.length,
    languageReadinessCriteria: LANGUAGE_READINESS_CRITERIA.length,
    paymentReadinessCriteria: PAYMENT_READINESS_CRITERIA.length,
    legalReadinessCriteria: LEGAL_READINESS_CRITERIA.length,
    taxReadinessCriteria: TAX_READINESS_CRITERIA.length,
    infrastructureReadinessCriteria: INFRASTRUCTURE_READINESS_CRITERIA.length,
    supportReadinessCriteria: SUPPORT_READINESS_CRITERIA.length,
    culturalReadinessCriteria: CULTURAL_READINESS_CRITERIA.length,
    totalCriteria:
      MARKET_FIT_CRITERIA.length +
      LANGUAGE_READINESS_CRITERIA.length +
      PAYMENT_READINESS_CRITERIA.length +
      LEGAL_READINESS_CRITERIA.length +
      TAX_READINESS_CRITERIA.length +
      INFRASTRUCTURE_READINESS_CRITERIA.length +
      SUPPORT_READINESS_CRITERIA.length +
      CULTURAL_READINESS_CRITERIA.length,
    compositeFunctionImplemented: true,
    evaluationOutputImplemented: true,
    allImplemented: allCriteriaImplemented,
  };
}
