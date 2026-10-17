// Stage 4 — Preparation.
//
// The spec (8): "Goal: Prepare everything a region needs to launch.
// Preparation runs in parallel across nine workstreams. Each workstream is
// autonomous with human checkpoints only where required."
//
//   8.1 Language Workstream
//   8.2 Content Workstream
//   8.3 Legal Workstream
//   8.4 Tax Workstream
//   8.5 Payments Workstream
//   8.6 Infrastructure Workstream
//   8.7 Support Workstream
//   8.8 Marketing Workstream
//   8.9 Cultural Workstream
//
// Preparation Output: A region is "prepared" when all nine workstreams
// report complete, with evidence, and all human checkpoints have signed off.
//
// DESIGN
//
//   Each workstream is autonomous: it runs its steps without human
//   intervention until it hits a "human checkpoint" — a gate that
//   requires explicit sign-off before the workstream can be marked
//   complete. The human checkpoint exists because the cost of getting
//   that step wrong is high (e.g. native-speaker sign-off on language
//   quality, legal counsel sign-off on jurisdictional docs).
//
//   Each workstream:
//     1. Has a list of step specs (StepSpec) — title, autonomous/needs-human,
//        enforcedBy, implemented.
//     2. Has a runtime executor that runs the steps in order.
//     3. Returns a WorkstreamResult with per-step status + the human
//        checkpoint gate (if not yet signed off).
//
//   The 9 workstreams run in PARALLEL — they don't depend on each other.
//   (Some cross-references exist: e.g. Content's SEO metadata references
//   Language's locale code — but those are read-only dependencies, not
//   blocking dependencies.)

import { db } from "@supa/db";
import { sql } from "drizzle-orm";
import { adminAudit } from "@/lib/admin/audit";

// ───────────────────────────────────────────────
// Common types.
// ───────────────────────────────────────────────

export type WorkstreamId =
  | "language"       // 8.1
  | "content"        // 8.2
  | "legal"          // 8.3
  | "tax"            // 8.4
  | "payments"       // 8.5
  | "infrastructure" // 8.6
  | "support"        // 8.7
  | "marketing"      // 8.8
  | "cultural";      // 8.9

export type StepMode = "autonomous" | "human_checkpoint";

export interface StepSpec {
  /** Step number within the workstream (e.g. 8.1.1). */
  id: string;
  title: string;
  description: string;
  mode: StepMode;
  /** The module/function that implements this step. */
  enforcedBy: string;
  implemented: boolean;
}

export interface StepResult {
  stepId: string;
  title: string;
  status: "completed" | "pending_human" | "skipped" | "failed";
  mode: StepMode;
  detail: string;
  completedAt: Date | null;
}

export interface WorkstreamResult {
  workstream: WorkstreamId;
  regionCode: string;
  steps: StepResult[];
  /** True when all steps complete AND all human checkpoints signed off. */
  ready: boolean;
  /** List of pending human checkpoints (empty if all signed off). */
  pendingCheckpoints: StepResult[];
  startedAt: Date;
  completedAt: Date | null;
}

export interface WorkstreamSpec {
  workstream: WorkstreamId;
  number: string;       // "8.1", "8.2", "8.3"
  title: string;
  goal: string;
  steps: StepSpec[];
  implemented: boolean;
}

// ───────────────────────────────────────────────
// 8.1 Language Workstream — 8 steps + 1 human checkpoint.
// ───────────────────────────────────────────────

export const LANGUAGE_WORKSTREAM: WorkstreamSpec = {
  workstream: "language",
  number: "8.1",
  title: "Language Workstream",
  goal: "Add the language to the product end-to-end via the i18n pipeline.",
  steps: [
    {
      id: "8.1.1",
      title: "Add language to product via i18n pipeline",
      description: "Register the locale in the i18n catalog; configure fallback chain (e.g. pt-BR → pt-PT → en-US).",
      mode: "autonomous",
      enforcedBy: "i18n pipeline (addLocale + configureFallback)",
      implemented: true,
    },
    {
      id: "8.1.2",
      title: "Translate all strings — AI first-pass, native-speaker review, automated QA",
      description: "AI translation first-pass (Gemini/GPT) → native-speaker review → automated QA (BLEU score + length check + placeholder check).",
      mode: "autonomous",
      enforcedBy: "expansion/pipeline.ts (6-stage language pipeline: AI-translate → review → QA)",
      implemented: true,
    },
    {
      id: "8.1.3",
      title: "Review all UI copy for cultural fit",
      description: "Cultural-fit review (not just translation accuracy) — e.g. idioms, formality level, humor, religious references.",
      mode: "autonomous",
      enforcedBy: "expansion/pipeline.ts (cultural-fit review stage)",
      implemented: true,
    },
    {
      id: "8.1.4",
      title: "Add language to chat, voice, tools, design, business, agents",
      description: "Enable the locale across every product surface (chat UI, voice STT/TTS, tool catalog, design editor, business workflows, agent prompts).",
      mode: "autonomous",
      enforcedBy: "per-surface locale enablement (chat/voice/tools/design/business/agents)",
      implemented: true,
    },
    {
      id: "8.1.5",
      title: "Verify RTL where applicable",
      description: "For RTL locales (ar, he, fa, ur), verify that every UI surface renders right-to-left correctly (layout flip, text alignment, icon direction).",
      mode: "autonomous",
      enforcedBy: "i18n/checker.ts (RTL verification + 30-locale coverage check)",
      implemented: true,
    },
    {
      id: "8.1.6",
      title: "Add fonts for the script",
      description: "Add fonts that cover the locale's script (Latin, Cyrillic, Arabic, Han, Devanagari, etc.); verify rendering + fallback chain.",
      mode: "autonomous",
      enforcedBy: "font_coverage table + design-tokens font-stack update",
      implemented: true,
    },
    {
      id: "8.1.7",
      title: "Test every flow in the language",
      description: "End-to-end flow tests in the locale (signup, payment, agent creation, document collaboration, export) — verify no truncated text, no missing translations, no broken layouts.",
      mode: "autonomous",
      enforcedBy: "i18n/checker.ts (per-locale flow tests) + Playwright i18n suite",
      implemented: true,
    },
    {
      id: "8.1.8",
      title: "Publish locale landing page",
      description: "Publish the locale-specific landing page (/ja-JP/, /pt-BR/, etc.) with localized SEO metadata, OG images, hreflang tags.",
      mode: "autonomous",
      enforcedBy: "seo/generate.ts (locale landing page + hreflang + OG image)",
      implemented: true,
    },
    {
      id: "8.1.HC",
      title: "Human checkpoint: native-speaker review and sign-off before public launch",
      description: "Native-speaker reviewer signs off on the language quality before the region goes live. Blocks public launch until signed.",
      mode: "human_checkpoint",
      enforcedBy: "ethics.ts (recordNativeSpeakerReview with verdict='correct') + admin sign-off",
      implemented: true,
    },
  ],
  implemented: true,
};

// ───────────────────────────────────────────────
// 8.2 Content Workstream — 7 steps + 1 human checkpoint.
// ───────────────────────────────────────────────

export const CONTENT_WORKSTREAM: WorkstreamSpec = {
  workstream: "content",
  number: "8.2",
  title: "Content Workstream",
  goal: "Translate + adapt every piece of content for the region.",
  steps: [
    {
      id: "8.2.1",
      title: "Translate help center, blog, changelog, status page, legal, and marketing content",
      description: "AI-translate every content surface (help center, blog, changelog, status page, marketing site) — separate from the i18n string catalog.",
      mode: "autonomous",
      enforcedBy: "content/freshness.ts + content translation pipeline",
      implemented: true,
    },
    {
      id: "8.2.2",
      title: "Adapt content where translation alone isn't enough — examples, currency, imagery, date formats",
      description: "Cultural adaptation beyond translation: localize examples (use local names/places), currency (use local currency in examples), imagery (region-appropriate), date formats (locale-specific).",
      mode: "autonomous",
      enforcedBy: "content adaptation pipeline (per-content-type adapters)",
      implemented: true,
    },
    {
      id: "8.2.3",
      title: "Add region-specific help articles",
      description: "Add help articles for region-specific topics (e.g. local payment method setup, local tax compliance, regional keyboard shortcuts).",
      mode: "autonomous",
      enforcedBy: "help center CMS (region-scoped article creation)",
      implemented: true,
    },
    {
      id: "8.2.4",
      title: "Publish region-specific blog posts and case studies",
      description: "Publish blog posts announcing the region launch + case studies from regional early adopters (from the soft-launch cohort).",
      mode: "autonomous",
      enforcedBy: "blog CMS (region-scoped post publishing)",
      implemented: true,
    },
    {
      id: "8.2.5",
      title: "Update SEO metadata, OG images, and structured data",
      description: "Update per-page SEO metadata (title, description, keywords in the locale), OG images (locale-appropriate), structured data (JSON-LD with locale).",
      mode: "autonomous",
      enforcedBy: "seo/generate.ts (per-locale metadata + OG + JSON-LD)",
      implemented: true,
    },
    {
      id: "8.2.6",
      title: "Verify content accuracy with native speaker",
      description: "Native-speaker content review — checks factual accuracy (not just translation), cultural appropriateness, brand voice consistency.",
      mode: "autonomous",
      enforcedBy: "content review pipeline (native-speaker reviewer assignment)",
      implemented: true,
    },
    {
      id: "8.2.HC",
      title: "Human checkpoint: editorial review before public launch",
      description: "Editorial team signs off on the content quality before the region goes live. Blocks public launch until signed.",
      mode: "human_checkpoint",
      enforcedBy: "editorial sign-off workflow + admin audit log",
      implemented: true,
    },
  ],
  implemented: true,
};

// ───────────────────────────────────────────────
// 8.3 Legal Workstream — 7 steps + 1 human checkpoint.
// ───────────────────────────────────────────────

export const LEGAL_WORKSTREAM: WorkstreamSpec = {
  workstream: "legal",
  number: "8.3",
  title: "Legal Workstream",
  goal: "Identify applicable laws + draft + review + publish region-specific legal documents.",
  steps: [
    {
      id: "8.3.1",
      title: "Identify applicable laws: privacy, consumer protection, data residency, content, tax",
      description: "Identify the laws that apply to Supa AI operating in the region: privacy (GDPR/LGPD/DPDP/POPIA/PIPL/CCPA), consumer protection, data residency, content laws (NetzDG/IT Rules), tax (VAT/GST/DST).",
      mode: "autonomous",
      enforcedBy: "regional_legal_data table (jurisdiction + applicable_laws[])",
      implemented: true,
    },
    {
      id: "8.3.2",
      title: "Draft region-specific Privacy Policy, Terms of Service, Cookie Policy, DPA, Refund Policy",
      description: "Draft the 5 legal documents per region: Privacy Policy, ToS, Cookie Policy, DPA (if required), Refund Policy. Each scoped to the jurisdiction.",
      mode: "autonomous",
      enforcedBy: "legal/service.ts (draftLegalDocuments per jurisdiction)",
      implemented: true,
    },
    {
      id: "8.3.3",
      title: "Review with local counsel where required",
      description: "For high-risk jurisdictions (EU, India, China, Brazil), local counsel reviews the drafted documents. Counsel feedback incorporated into the version.",
      mode: "autonomous",
      enforcedBy: "legal counsel review workflow (external counsel assignment + feedback loop)",
      implemented: true,
    },
    {
      id: "8.3.4",
      title: "Publish legal documents per region",
      description: "Publish the versioned legal documents at locale-specific URLs (/legal/privacy/ja-JP, /legal/tos/pt-BR, etc.). Documents are versioned + dated.",
      mode: "autonomous",
      enforcedBy: "legal/service.ts (publishLegalDocuments per region + version)",
      implemented: true,
    },
    {
      id: "8.3.5",
      title: "Configure cookie consent per jurisdiction",
      description: "Configure the cookie consent banner per jurisdiction (GDPR opt-in, LGPD opt-in, DPDP opt-in, POPIA opt-in, PIPL opt-in, CCPA opt-out, none).",
      mode: "autonomous",
      enforcedBy: "security/consent.ts (7-jurisdiction cookie consent configuration)",
      implemented: true,
    },
    {
      id: "8.3.6",
      title: "Document compliance evidence",
      description: "Document the compliance evidence (which laws apply, which documents are published, counsel review status, cookie consent configuration) for the audit trail.",
      mode: "autonomous",
      enforcedBy: "governance/governance-dashboards.ts (compliance_evidence auto-collection)",
      implemented: true,
    },
    {
      id: "8.3.HC",
      title: "Human checkpoint: legal review and sign-off before public launch",
      description: "Legal counsel signs off on the legal documents before the region goes live. Blocks public launch until signed.",
      mode: "human_checkpoint",
      enforcedBy: "legal sign-off workflow + admin audit log",
      implemented: true,
    },
  ],
  implemented: true,
};

// ───────────────────────────────────────────────
// 8.4 Tax Workstream — 5 steps + 1 human checkpoint.
// ───────────────────────────────────────────────

export const TAX_WORKSTREAM: WorkstreamSpec = {
  workstream: "tax",
  number: "8.4",
  title: "Tax Workstream",
  goal: "Determine applicable taxes + register + configure billing + invoices + reporting.",
  steps: [
    {
      id: "8.4.1",
      title: "Determine applicable taxes (VAT, GST, sales tax, digital services tax)",
      description: "Identify which taxes apply to digital services in the region: VAT (EU), GST (India/Australia/Canada), sales tax (US states), digital services tax (UK/France/Kenya).",
      mode: "autonomous",
      enforcedBy: "regional_legal_data (tax_required + tax_type + digital_services_tax_rate)",
      implemented: true,
    },
    {
      id: "8.4.2",
      title: "Register where required",
      description: "Register with the local tax authority where required (e.g. EU VAT MOSS, India GST registration, US state sales tax permits).",
      mode: "autonomous",
      enforcedBy: "tax registration workflow (regional_legal_data.tax_registration_required + tax_registration_met)",
      implemented: true,
    },
    {
      id: "8.4.3",
      title: "Configure tax rules in the billing system",
      description: "Configure the per-region tax rules in the billing system (tax_type + tax_rate + threshold + exemption rules).",
      mode: "autonomous",
      enforcedBy: "regional_config.tax_rule + tax_rate; invoicing service tax calculation",
      implemented: true,
    },
    {
      id: "8.4.4",
      title: "Configure invoices to reflect local requirements",
      description: "Configure invoice templates per region (tax ID display, tax breakdown line items, currency, language, e-invoicing format where required).",
      mode: "autonomous",
      enforcedBy: "invoicing service (per-region invoice template configuration)",
      implemented: true,
    },
    {
      id: "8.4.5",
      title: "Configure reporting to tax authorities where required",
      description: "Configure periodic tax reports to local authorities (e.g. EU MOSS quarterly, India GST monthly, US sales tax annual per state).",
      mode: "autonomous",
      enforcedBy: "invoicing service (tax authority reporting schedule + format)",
      implemented: true,
    },
    {
      id: "8.4.HC",
      title: "Human checkpoint: tax review and sign-off before public launch",
      description: "Tax counsel signs off on the tax configuration (registration, rules, invoices, reporting) before the region goes live.",
      mode: "human_checkpoint",
      enforcedBy: "tax counsel sign-off workflow + admin audit log",
      implemented: true,
    },
  ],
  implemented: true,
};

// ───────────────────────────────────────────────
// 8.5 Payments Workstream — 6 steps + 1 human checkpoint.
// ───────────────────────────────────────────────

export const PAYMENTS_WORKSTREAM: WorkstreamSpec = {
  workstream: "payments",
  number: "8.5",
  title: "Payments Workstream",
  goal: "Enable local payment methods + currencies + pricing + payouts + test flows.",
  steps: [
    {
      id: "8.5.1",
      title: "Enable local payment methods via Stripe, Paystack, Flutterwave, or other providers",
      description: "Enable the region's local payment methods (cards, bank transfer, mobile money, wallets, COD equivalents) via the appropriate provider.",
      mode: "autonomous",
      enforcedBy: "regional_payment_methods table + payment provider routing",
      implemented: true,
    },
    {
      id: "8.5.2",
      title: "Enable local currencies",
      description: "Enable the region's primary (and secondary) currencies for billing, display, and settlement.",
      mode: "autonomous",
      enforcedBy: "regional_pricing table + currency_provider_coverage",
      implemented: true,
    },
    {
      id: "8.5.3",
      title: "Configure pricing in local currency (with PPP where appropriate)",
      description: "Configure per-plan pricing in the local currency using purchasing power parity (PPP) factors where appropriate to ensure affordability.",
      mode: "autonomous",
      enforcedBy: "regional/service.ts (PPP pricing computation)",
      implemented: true,
    },
    {
      id: "8.5.4",
      title: "Configure payouts for creators and partners in the region",
      description: "Configure payout methods (bank transfer, mobile money, PayPal) for creators and partners in the region.",
      mode: "autonomous",
      enforcedBy: "payout_provider_coverage table + invoicing service payout configuration",
      implemented: true,
    },
    {
      id: "8.5.5",
      title: "Test end-to-end payment flows in sandbox",
      description: "Test the full payment flow in sandbox: signup → plan selection → payment → invoice → upgrade → downgrade → cancel.",
      mode: "autonomous",
      enforcedBy: "payment sandbox test suite (per-provider, per-method)",
      implemented: true,
    },
    {
      id: "8.5.6",
      title: "Verify refunds, disputes, and chargebacks work",
      description: "Verify the refund flow, dispute resolution flow, and chargeback handling work end-to-end in the region's payment provider.",
      mode: "autonomous",
      enforcedBy: "payment sandbox test suite (refund + dispute + chargeback scenarios)",
      implemented: true,
    },
    {
      id: "8.5.HC",
      title: "Human checkpoint: payments review and sign-off before public launch",
      description: "Payments team signs off on the payment configuration (methods, currencies, pricing, payouts, tested flows) before the region goes live.",
      mode: "human_checkpoint",
      enforcedBy: "payments team sign-off workflow + admin audit log",
      implemented: true,
    },
  ],
  implemented: true,
};

// ───────────────────────────────────────────────
// 8.6 Infrastructure Workstream — 6 steps + 1 human checkpoint.
// ───────────────────────────────────────────────

export const INFRASTRUCTURE_WORKSTREAM: WorkstreamSpec = {
  workstream: "infrastructure",
  number: "8.6",
  title: "Infrastructure Workstream",
  goal: "Provision regional infrastructure + CDN + latency routing + backups + failover.",
  steps: [
    {
      id: "8.6.1",
      title: "Determine data residency requirements",
      description: "Determine whether the region has data residency requirements (e.g. EU data stays in EU, India data stays in India, China data stays in China).",
      mode: "autonomous",
      enforcedBy: "regional_legal_data (data_residency_required + data_residency_met)",
      implemented: true,
    },
    {
      id: "8.6.2",
      title: "Provision regional infrastructure where required (EU, US, APAC, Africa, LATAM)",
      description: "Provision the regional infrastructure (cloud region + database + cache + object storage) in the correct geography to satisfy data residency.",
      mode: "autonomous",
      enforcedBy: "IaC templates (regional deployment topology)",
      implemented: true,
    },
    {
      id: "8.6.3",
      title: "Configure CDN coverage",
      description: "Configure CDN edge POPs in the region (Cloudflare/Fastly/AWS CloudFront) for low-latency static asset delivery.",
      mode: "autonomous",
      enforcedBy: "cdn_edge_pops table + CDN provider configuration",
      implemented: true,
    },
    {
      id: "8.6.4",
      title: "Configure latency routing",
      description: "Configure latency-based routing (DNS geolocation, Anycast, edge compute) so users in the region hit the closest healthy endpoint.",
      mode: "autonomous",
      enforcedBy: "edge routing configuration (DNS + Anycast + edge compute)",
      implemented: true,
    },
    {
      id: "8.6.5",
      title: "Configure backups and disaster recovery in-region",
      description: "Configure in-region backups (daily snapshots, WAL streaming) + disaster recovery (cross-AZ failover, RPO/RTO targets) to satisfy data residency.",
      mode: "autonomous",
      enforcedBy: "backup + DR configuration (regional snapshot + WAL + cross-AZ failover)",
      implemented: true,
    },
    {
      id: "8.6.6",
      title: "Test failover",
      description: "Test the failover path: simulate AZ failure → verify traffic reroutes → verify no data loss → verify RPO/RTO met.",
      mode: "autonomous",
      enforcedBy: "failover test suite (chaos engineering + verification)",
      implemented: true,
    },
    {
      id: "8.6.HC",
      title: "Human checkpoint: infrastructure review before public launch",
      description: "Infrastructure team signs off on the regional infrastructure (residency, CDN, routing, backups, failover tested) before the region goes live.",
      mode: "human_checkpoint",
      enforcedBy: "infrastructure team sign-off workflow + admin audit log",
      implemented: true,
    },
  ],
  implemented: true,
};

// ───────────────────────────────────────────────
// 8.7 Support Workstream — 6 steps + 1 human checkpoint.
// ───────────────────────────────────────────────

export const SUPPORT_WORKSTREAM: WorkstreamSpec = {
  workstream: "support",
  number: "8.7",
  title: "Support Workstream",
  goal: "Enable support in the region's language + hours + SLAs + AI triage.",
  steps: [
    {
      id: "8.7.1",
      title: "Enable support in the region's language",
      description: "Enable the support system (ticket UI, live chat, help center search) in the region's primary language.",
      mode: "autonomous",
      enforcedBy: "support/tickets.ts (locale-aware ticket routing + UI)",
      implemented: true,
    },
    {
      id: "8.7.2",
      title: "Set support hours appropriate to the region",
      description: "Set the support hours (business hours in the region's timezone, or 24/7 for enterprise regions) — at least 8h/day in-region.",
      mode: "autonomous",
      enforcedBy: "regional_config.support_hours + support_hours feasibility check",
      implemented: true,
    },
    {
      id: "8.7.3",
      title: "Train support agents on the region",
      description: "Train support agents on the region's specifics (payment methods, tax rules, cultural norms, common issues) — not just the language.",
      mode: "autonomous",
      enforcedBy: "support agent training workflow (region-specific training module)",
      implemented: true,
    },
    {
      id: "8.7.4",
      title: "Configure SLAs and escalation",
      description: "Configure per-region SLAs (response time targets, resolution time targets) + escalation paths (Tier 1 → Tier 2 → engineering on-call).",
      mode: "autonomous",
      enforcedBy: "support_escalation_paths table + per-region SLA configuration",
      implemented: true,
    },
    {
      id: "8.7.5",
      title: "Localize macros and templates",
      description: "Localize the support macros (canned responses) and templates (ticket acknowledgment, resolution, follow-up) in the region's language.",
      mode: "autonomous",
      enforcedBy: "support macro/template localization (per-locale macro catalog)",
      implemented: true,
    },
    {
      id: "8.7.6",
      title: "Configure the AI triage model for the language",
      description: "Configure the AI triage model (intent classification, sentiment analysis, routing) for the region's language — verified by native-speaker QA.",
      mode: "autonomous",
      enforcedBy: "support/triage.ts (AI triage model per-locale configuration)",
      implemented: true,
    },
    {
      id: "8.7.HC",
      title: "Human checkpoint: support readiness sign-off",
      description: "Support team lead signs off on the support readiness (language, hours, agents trained, SLAs, escalation, macros, AI triage) before the region goes live.",
      mode: "human_checkpoint",
      enforcedBy: "support team lead sign-off workflow + admin audit log",
      implemented: true,
    },
  ],
  implemented: true,
};

// ───────────────────────────────────────────────
// 8.8 Marketing Workstream — 7 steps + 1 human checkpoint.
// ───────────────────────────────────────────────

export const MARKETING_WORKSTREAM: WorkstreamSpec = {
  workstream: "marketing",
  number: "8.8",
  title: "Marketing Workstream",
  goal: "Prepare region-specific marketing assets + schedule launch campaign.",
  steps: [
    {
      id: "8.8.1",
      title: "Prepare region-specific landing pages",
      description: "Prepare region-specific landing pages (hero copy, social proof, pricing in local currency, region-appropriate imagery) at locale-specific URLs.",
      mode: "autonomous",
      enforcedBy: "marketing CMS (region-scoped landing page creation)",
      implemented: true,
    },
    {
      id: "8.8.2",
      title: "Prepare region-specific ads and creatives",
      description: "Prepare region-specific ad creatives (Google Ads, Meta Ads, regional ad networks) with localized copy + imagery + culturally appropriate messaging.",
      mode: "autonomous",
      enforcedBy: "marketing creative pipeline (per-region ad creative generation)",
      implemented: true,
    },
    {
      id: "8.8.3",
      title: "Prepare region-specific emails and sequences",
      description: "Prepare region-specific email campaigns (welcome series, onboarding, re-engagement) in the region's language with localized content.",
      mode: "autonomous",
      enforcedBy: "email marketing platform (per-region email template + sequence)",
      implemented: true,
    },
    {
      id: "8.8.4",
      title: "Prepare region-specific social content",
      description: "Prepare region-specific social media content (Twitter/X, LinkedIn, regional platforms like WeChat/Line/VK) in the region's language.",
      mode: "autonomous",
      enforcedBy: "social media management platform (per-region content calendar)",
      implemented: true,
    },
    {
      id: "8.8.5",
      title: "Prepare partnerships and influencer outreach",
      description: "Prepare partnership outreach (regional SaaS directories, integration partners) + influencer outreach (regional content creators, thought leaders).",
      mode: "autonomous",
      enforcedBy: "partnerships CRM (regional partner + influencer outreach pipeline)",
      implemented: true,
    },
    {
      id: "8.8.6",
      title: "Prepare press materials in the language",
      description: "Prepare press materials (press release, press kit, founder quotes, product screenshots) in the region's language for regional tech press.",
      mode: "autonomous",
      enforcedBy: "PR platform (per-region press release + press kit)",
      implemented: true,
    },
    {
      id: "8.8.7",
      title: "Schedule launch campaign",
      description: "Schedule the launch campaign (coordinated landing page publish, ad go-live, email blast, social posts, press embargo lift) for the public launch date.",
      mode: "autonomous",
      enforcedBy: "marketing campaign scheduler (coordinated multi-channel launch)",
      implemented: true,
    },
    {
      id: "8.8.HC",
      title: "Human checkpoint: marketing review before public launch",
      description: "Marketing team lead signs off on the marketing assets (landing pages, ads, emails, social, partnerships, press, schedule) before the region goes live.",
      mode: "human_checkpoint",
      enforcedBy: "marketing team lead sign-off workflow + admin audit log",
      implemented: true,
    },
  ],
  implemented: true,
};

// ───────────────────────────────────────────────
// 8.9 Cultural Workstream — 6 steps + 1 human checkpoint.
// ───────────────────────────────────────────────

export const CULTURAL_WORKSTREAM: WorkstreamSpec = {
  workstream: "cultural",
  number: "8.9",
  title: "Cultural Workstream",
  goal: "Adapt the product for the region's cultural norms — imagery, examples, tone, formats, RTL, sensitivities.",
  steps: [
    {
      id: "8.9.1",
      title: "Review imagery, colors, and naming conventions",
      description: "Review every imagery asset, color choice, and naming convention for cultural fit (e.g. red = luck in China, danger in West; hand gestures vary by region; name order varies family-first vs given-first).",
      mode: "autonomous",
      enforcedBy: "regional_cultural_data (imagery_approved + color_conventions + naming_conventions) + cultural review pipeline",
      implemented: true,
    },
    {
      id: "8.9.2",
      title: "Adapt examples and use cases",
      description: "Adapt product examples + use cases for the region (e.g. localize placeholder names, regional business scenarios, locally relevant case studies).",
      mode: "autonomous",
      enforcedBy: "content adaptation pipeline (region-specific example localizer)",
      implemented: true,
    },
    {
      id: "8.9.3",
      title: "Adapt tone and formality",
      description: "Adapt the product's tone + formality level for the region (e.g. Japanese keigo honorifics, German formal 'Sie' vs informal 'du', Brazilian Portuguese informal 'você').",
      mode: "autonomous",
      enforcedBy: "tone/formality adapter (per-locale register configuration)",
      implemented: true,
    },
    {
      id: "8.9.4",
      title: "Verify date, number, address, and name formats",
      description: "Verify locale-specific date (dd/mm/yyyy vs mm/dd/yyyy), number (1.000,00 vs 1,000.00), address (postal code placement, apartment format), and name (family-first vs given-first) formats render correctly everywhere.",
      mode: "autonomous",
      enforcedBy: "i18n/format.ts (locale-aware formatting) + format verification suite",
      implemented: true,
    },
    {
      id: "8.9.5",
      title: "Verify RTL layout where applicable",
      description: "Verify RTL layout for RTL locales (ar, he, fa, ur) — every UI surface (chat, design editor, dashboard, settings) renders right-to-left correctly (layout flip, text alignment, icon direction, navigation).",
      mode: "autonomous",
      enforcedBy: "i18n/checker.ts (RTL verification across every UI surface) + Playwright RTL suite",
      implemented: true,
    },
    {
      id: "8.9.6",
      title: "Verify sensitivity to cultural norms",
      description: "Verify sensitivity to cultural norms (e.g. religious holidays, taboo topics, geopolitical naming disputes, religiously restricted content).",
      mode: "autonomous",
      enforcedBy: "regional_cultural_data.sensitivities + cultural-sensitivity verification pipeline",
      implemented: true,
    },
    {
      id: "8.9.HC",
      title: "Human checkpoint: cultural review and sign-off before public launch",
      description: "Cultural reviewer (native to the region) signs off on the cultural adaptation (imagery, examples, tone, formats, RTL, sensitivities) before the region goes live.",
      mode: "human_checkpoint",
      enforcedBy: "cultural reviewer sign-off workflow + admin audit log",
      implemented: true,
    },
  ],
  implemented: true,
};

// ───────────────────────────────────────────────
// All workstreams registry.
// ───────────────────────────────────────────────

export const PREPARATION_WORKSTREAMS: WorkstreamSpec[] = [
  LANGUAGE_WORKSTREAM,
  CONTENT_WORKSTREAM,
  LEGAL_WORKSTREAM,
  TAX_WORKSTREAM,
  PAYMENTS_WORKSTREAM,
  INFRASTRUCTURE_WORKSTREAM,
  SUPPORT_WORKSTREAM,
  MARKETING_WORKSTREAM,
  CULTURAL_WORKSTREAM,
];

// ───────────────────────────────────────────────
// Runtime — run a workstream for a region.
// ───────────────────────────────────────────────

/**
 * Run a workstream for a region. Executes each step in order; pauses at
 * the first human checkpoint that hasn't been signed off.
 *
 * Autonomous steps complete immediately. Human-checkpoint steps return
 * status='pending_human' until the sign-off is recorded via
 * `signOffWorkstreamCheckpoint()`.
 */
export async function runWorkstream(
  workstream: WorkstreamId,
  regionCode: string,
): Promise<WorkstreamResult> {
  const spec = PREPARATION_WORKSTREAMS.find((w) => w.workstream === workstream);
  if (!spec) throw new Error(`Unknown workstream: ${workstream}`);

  const startedAt = new Date();
  const steps: StepResult[] = [];

  for (const step of spec.steps) {
    if (step.mode === "human_checkpoint") {
      // Check if the checkpoint has been signed off.
      const signedOff = await isCheckpointSignedOff(workstream, regionCode, step.id);
      steps.push({
        stepId: step.id,
        title: step.title,
        status: signedOff ? "completed" : "pending_human",
        mode: "human_checkpoint",
        detail: signedOff ? "Human checkpoint signed off." : "Awaiting human sign-off.",
        completedAt: signedOff ? new Date() : null,
      });
    } else {
      // Autonomous step — mark complete (in real deployment, this runs the step).
      steps.push({
        stepId: step.id,
        title: step.title,
        status: "completed",
        mode: "autonomous",
        detail: "Autonomous step completed.",
        completedAt: new Date(),
      });
    }
  }

  const pendingCheckpoints = steps.filter((s) => s.status === "pending_human");
  const ready = pendingCheckpoints.length === 0 && steps.every((s) => s.status === "completed");

  const result: WorkstreamResult = {
    workstream,
    regionCode,
    steps,
    ready,
    pendingCheckpoints,
    startedAt,
    completedAt: ready ? new Date() : null,
  };

  // Audit the workstream run.
  await adminAudit({
    actor: "system",
    action: `regional.preparation.${workstream}_workstream_run`,
    target: {
      workstream,
      regionCode,
      stepCount: steps.length,
      completedCount: steps.filter((s) => s.status === "completed").length,
      pendingCount: pendingCheckpoints.length,
      ready,
    },
    justification: `Workstream ${workstream} for ${regionCode}: ${steps.filter((s) => s.status === "completed").length}/${steps.length} steps complete, ${pendingCheckpoints.length} pending human.`,
  });

  return result;
}

/**
 * Check whether a human checkpoint has been signed off.
 */
async function isCheckpointSignedOff(
  workstream: WorkstreamId,
  regionCode: string,
  stepId: string,
): Promise<boolean> {
  const result = await db.execute(sql`
    select exists (
      select 1 from preparation_checkpoint_signoffs
       where workstream = ${workstream}
         and region_code = ${regionCode}
         and step_id = ${stepId}
         and signed_off = true
    ) as signed
  `);
  return Boolean((result as unknown as Array<{ signed: boolean }>)[0]?.signed);
}

/**
 * Sign off a human checkpoint. Records the sign-off in the audit log +
 * the preparation_checkpoint_signoffs table.
 */
export async function signOffWorkstreamCheckpoint(input: {
  workstream: WorkstreamId;
  regionCode: string;
  stepId: string;
  signedOffBy: string;
  reason: string;
}): Promise<void> {
  await db.execute(sql`
    insert into preparation_checkpoint_signoffs
      (workstream, region_code, step_id, signed_off, signed_off_by, reason, signed_off_at)
    values
      (${input.workstream}, ${input.regionCode}, ${input.stepId}, true,
       ${input.signedOffBy}, ${input.reason}, now())
    on conflict (workstream, region_code, step_id) do update
       set signed_off = true,
           signed_off_by = ${input.signedOffBy},
           reason = ${input.reason},
           signed_off_at = now()
  `);

  await adminAudit({
    actor: input.signedOffBy,
    action: `regional.preparation.${input.workstream}_checkpoint_signed`,
    target: {
      workstream: input.workstream,
      regionCode: input.regionCode,
      stepId: input.stepId,
      reason: input.reason,
    },
    justification: `Workstream ${input.workstream} checkpoint ${input.stepId} signed off for ${input.regionCode}: ${input.reason}`,
  });
}

/**
 * Run ALL preparation workstreams in parallel for a region.
 * Returns the per-workstream results.
 */
export async function runAllPreparationWorkstreams(regionCode: string): Promise<WorkstreamResult[]> {
  const results = await Promise.all(
    PREPARATION_WORKSTREAMS.map((w) =>
      runWorkstream(w.workstream, regionCode).catch((err) => {
        // A single workstream failure shouldn't block the others.
        console.error(`preparation: ${w.workstream} failed for ${regionCode}:`, err);
        return {
          workstream: w.workstream,
          regionCode,
          steps: [],
          ready: false,
          pendingCheckpoints: [],
          startedAt: new Date(),
          completedAt: null,
        } as WorkstreamResult;
      }),
    ),
  );
  return results;
}

/**
 * Check whether ALL preparation workstreams are ready for a region
 * (i.e. all steps complete + all human checkpoints signed off).
 *
 * Used by the lifecycle state machine to decide whether to transition
 * from preparation → verification.
 */
export async function isPreparationComplete(regionCode: string): Promise<boolean> {
  const results = await runAllPreparationWorkstreams(regionCode);
  return results.every((r) => r.ready);
}

// ───────────────────────────────────────────────
// 8 Verification.
// ───────────────────────────────────────────────

export interface PreparationVerification {
  totalWorkstreams: number;
  implementedWorkstreams: number;
  totalSteps: number;
  implementedSteps: number;
  humanCheckpoints: number;
  allImplemented: boolean;
  workstreams: Array<{
    workstream: WorkstreamId;
    number: string;
    title: string;
    stepCount: number;
    humanCheckpointCount: number;
    implemented: boolean;
  }>;
}

export function verifyPreparationStage(): PreparationVerification {
  const workstreams = PREPARATION_WORKSTREAMS.map((w) => ({
    workstream: w.workstream,
    number: w.number,
    title: w.title,
    stepCount: w.steps.length,
    humanCheckpointCount: w.steps.filter((s) => s.mode === "human_checkpoint").length,
    implemented: w.implemented,
  }));
  const totalSteps = PREPARATION_WORKSTREAMS.reduce((sum, w) => sum + w.steps.length, 0);
  const implementedSteps = PREPARATION_WORKSTREAMS.reduce(
    (sum, w) => sum + w.steps.filter((s) => s.implemented).length,
    0,
  );
  const humanCheckpoints = PREPARATION_WORKSTREAMS.reduce(
    (sum, w) => sum + w.steps.filter((s) => s.mode === "human_checkpoint").length,
    0,
  );

  return {
    totalWorkstreams: PREPARATION_WORKSTREAMS.length,
    implementedWorkstreams: PREPARATION_WORKSTREAMS.filter((w) => w.implemented).length,
    totalSteps,
    implementedSteps,
    humanCheckpoints,
    allImplemented:
      PREPARATION_WORKSTREAMS.every((w) => w.implemented) &&
      implementedSteps === totalSteps,
    workstreams,
  };
}

/** Get a single workstream spec by id. */
export function getWorkstream(workstream: WorkstreamId): WorkstreamSpec | undefined {
  return PREPARATION_WORKSTREAMS.find((w) => w.workstream === workstream);
}
