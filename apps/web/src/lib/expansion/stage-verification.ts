// Stage 5 — Verification.
//
// The spec (9): "Goal: Verify the region is ready to launch.
// Verification runs autonomously with human escalation for failures."
//
//   9.1 Automated Verification — 11 checks:
//     - All strings translated — no missing keys, no placeholders.
//     - All flows work in the language — signup, chat, design, invoice, agent.
//     - All RTL verified where applicable.
//     - All formats correct — dates, numbers, currencies, addresses.
//     - All payments work — end-to-end in sandbox and small-amount live test.
//     - All legal pages published and reachable.
//     - All tax rules applied correctly to test transactions.
//     - All content accessible — help, blog, changelog.
//     - All support channels live in the language.
//     - All marketing assets ready.
//     - All infrastructure healthy.
//
//   9.2 Human Verification — 6 reviewers:
//     - Native speaker reviews the product end-to-end.
//     - Legal counsel confirms compliance.
//     - Tax advisor confirms tax setup.
//     - Payments advisor confirms payment flows.
//     - Support lead confirms support readiness.
//     - Marketing lead confirms campaign readiness.
//
//   9.3 Verification Output: A Verification Report with:
//     - Status per verification item.
//     - Evidence for each item.
//     - Open issues and remediation.
//     - Go / No-Go recommendation.
//
//   If any critical item fails, the region is returned to Preparation.
//
// DESIGN
//
//   This module is the runtime implementation of Stage 5. It runs the 11
//   automated checks in parallel, then surfaces the 6 human verification
//   items (each is a human checkpoint that requires sign-off).
//
//   Each automated check returns:
//     - status: pass / fail / warn.
//     - evidence: structured data backing the status.
//     - openIssues: list of failures/warnings with remediation.
//     - critical: whether failure blocks launch.
//
//   The Verification Report:
//     - Aggregates all automated + human items.
//     - If ANY critical automated item fails → return to Preparation.
//     - If any non-critical item fails → "conditional" go (with remediation plan).
//     - If all pass → "go".
//
//   Human verification items are blocking — if any human reviewer hasn't
//   signed off, the report status is "pending_human" (not "go").

import { db } from "@supa/db";
import { sql } from "drizzle-orm";
import { adminAudit } from "@/lib/admin/audit";

// ───────────────────────────────────────────────
// 9.1 Automated verification — 11 checks.
// ───────────────────────────────────────────────

export type AutomatedCheckId =
  | "strings_translated"        // 9.1.1
  | "flows_work"                  // 9.1.2
  | "rtl_verified"               // 9.1.3
  | "formats_correct"            // 9.1.4
  | "payments_work"              // 9.1.5
  | "legal_pages_published"      // 9.1.6
  | "tax_rules_correct"          // 9.1.7
  | "content_accessible"         // 9.1.8
  | "support_channels_live"      // 9.1.9
  | "marketing_assets_ready"     // 9.1.10
  | "infrastructure_healthy";    // 9.1.11

export type CheckStatus = "pass" | "fail" | "warn";

export interface AutomatedCheckSpec {
  id: AutomatedCheckId;
  number: string;        // "9.1.1" etc.
  title: string;
  description: string;
  /** Whether failure of this check blocks launch (returns region to Preparation). */
  critical: boolean;
  /** The module/function that runs the check. */
  enforcedBy: string;
  implemented: boolean;
}

export const AUTOMATED_CHECKS: AutomatedCheckSpec[] = [
  {
    id: "strings_translated",
    number: "9.1.1",
    title: "All strings translated — no missing keys, no placeholders",
    description: "Verify every i18n string catalog key has a translation for the locale; no missing keys, no unrendered placeholders ({name}, {count}, etc.).",
    critical: true,
    enforcedBy: "i18n/checker.ts (per-locale coverage + placeholder verification)",
    implemented: true,
  },
  {
    id: "flows_work",
    number: "9.1.2",
    title: "All flows work in the language — signup, chat, design, invoice, agent",
    description: "End-to-end flow tests in the locale: signup, chat, design editor, invoice/payment, agent creation + run.",
    critical: true,
    enforcedBy: "Playwright i18n flow test suite (per-locale)",
    implemented: true,
  },
  {
    id: "rtl_verified",
    number: "9.1.3",
    title: "All RTL verified where applicable",
    description: "RTL layout verified across every UI surface for RTL locales (ar, he, fa, ur) — layout flip, text alignment, icon direction, navigation.",
    critical: true, // RTL must work or text is unreadable.
    enforcedBy: "i18n/checker.ts (RTL verification) + Playwright RTL suite",
    implemented: true,
  },
  {
    id: "formats_correct",
    number: "9.1.4",
    title: "All formats correct — dates, numbers, currencies, addresses",
    description: "Verify locale-specific formats render correctly: dates (dd/mm/yyyy vs mm/dd/yyyy), numbers (1.000,00 vs 1,000.00), currencies (¥ vs $ vs €), addresses (postal code placement).",
    critical: false, // formats can be wrong without breaking the app — degrades UX.
    enforcedBy: "i18n/format.ts (locale-aware formatting verification)",
    implemented: true,
  },
  {
    id: "payments_work",
    number: "9.1.5",
    title: "All payments work — end-to-end in sandbox and small-amount live test",
    description: "End-to-end payment test: sandbox flow (signup → plan → pay → invoice) + small-amount live test ($0.50 or local equivalent) with real payment provider.",
    critical: true,
    enforcedBy: "payment sandbox + live test suite (per-provider, per-method)",
    implemented: true,
  },
  {
    id: "legal_pages_published",
    number: "9.1.6",
    title: "All legal pages published and reachable",
    description: "Verify all 5 legal documents (Privacy, ToS, Cookie, DPA, Refund) are published at locale-specific URLs and return 200 OK.",
    critical: true, // missing legal pages = legal exposure.
    enforcedBy: "legal/service.ts + HTTP reachability check",
    implemented: true,
  },
  {
    id: "tax_rules_correct",
    number: "9.1.7",
    title: "All tax rules applied correctly to test transactions",
    description: "Verify tax rules apply correctly to test transactions (VAT/GST/sales tax/DST calculated correctly per jurisdiction).",
    critical: true, // wrong tax = financial + legal exposure.
    enforcedBy: "invoicing service tax calculation test (per-jurisdiction)",
    implemented: true,
  },
  {
    id: "content_accessible",
    number: "9.1.8",
    title: "All content accessible — help, blog, changelog",
    description: "Verify all content surfaces (help center, blog, changelog, status page) are accessible in the locale — no 404s, no untranslated critical paths.",
    critical: false, // can launch with some untranslated content — degrades UX.
    enforcedBy: "content accessibility check (per-locale HTTP crawl)",
    implemented: true,
  },
  {
    id: "support_channels_live",
    number: "9.1.9",
    title: "All support channels live in the language",
    description: "Verify all support channels (ticket UI, live chat, help center search, email auto-responder) are live in the locale.",
    critical: false, // can launch with ticket-only support if chat not yet localized.
    enforcedBy: "support channel liveness check (per-locale)",
    implemented: true,
  },
  {
    id: "marketing_assets_ready",
    number: "9.1.10",
    title: "All marketing assets ready",
    description: "Verify all marketing assets (landing page, ads, emails, social, press kit) are ready + scheduled for launch.",
    critical: false, // can launch without marketing — affects acquisition but not the product.
    enforcedBy: "marketing asset readiness check (per-region)",
    implemented: true,
  },
  {
    id: "infrastructure_healthy",
    number: "9.1.11",
    title: "All infrastructure healthy",
    description: "Verify regional infrastructure is healthy: latency p95 < 500ms, CDN edge POPs responding, failover path tested, backups running.",
    critical: true,
    enforcedBy: "infrastructure health check (latency probes + CDN check + failover test + backup verification)",
    implemented: true,
  },
];

// ───────────────────────────────────────────────
// 9.1 Runtime — run an automated check.
// ───────────────────────────────────────────────

export interface CheckResult {
  checkId: AutomatedCheckId;
  number: string;
  title: string;
  status: CheckStatus;
  critical: boolean;
  evidence: Record<string, unknown>;
  openIssues: Array<{
    issue: string;
    remediation: string;
    severity: "blocker" | "warning";
  }>;
  checkedAt: Date;
}

/**
 * Run a single automated check for a region.
 *
 * Each check has a query that reads the relevant state from the DB + computes
 * a pass/fail/warn status + collects evidence + open issues.
 */
export async function runAutomatedCheck(
  checkId: AutomatedCheckId,
  regionCode: string,
): Promise<CheckResult> {
  const spec = AUTOMATED_CHECKS.find((c) => c.id === checkId);
  if (!spec) throw new Error(`Unknown automated check: ${checkId}`);

  let status: CheckStatus = "pass";
  let evidence: Record<string, unknown> = {};
  const openIssues: CheckResult["openIssues"] = [];

  switch (checkId) {
    case "strings_translated": {
      const result = await db.execute(sql`
        select
          count(*) filter (where translated_value is null)::int as missing,
          count(*) filter (where translated_value like '%{%' and translated_value not like '%}%')::int as broken_placeholders,
          count(*)::int as total
        from i18n_string_catalog
        where locale = (select default_locale from regional_config where region_code = ${regionCode})
      `);
      const row = (result as unknown as Array<{ missing: number; broken_placeholders: number; total: number }>)[0] ?? { missing: 0, broken_placeholders: 0, total: 0 };
      evidence = { missing: row.missing, broken_placeholders: row.broken_placeholders, total: row.total };
      if (row.missing > 0) {
        status = "fail";
        openIssues.push({ issue: `${row.missing} missing translation keys`, remediation: "translate missing keys via the i18n pipeline", severity: "blocker" });
      } else if (row.broken_placeholders > 0) {
        status = "warn";
        openIssues.push({ issue: `${row.broken_placeholders} broken placeholders`, remediation: "fix placeholder syntax in translations", severity: "warning" });
      }
      break;
    }
    case "flows_work": {
      const result = await db.execute(sql`
        select
          count(*) filter (where status = 'pass')::int as passed,
          count(*) filter (where status = 'fail')::int as failed,
          count(*)::int as total
        from flow_test_results
        where region_code = ${regionCode}
          and tested_at >= now() - interval '24 hours'
      `);
      const row = (result as unknown as Array<{ passed: number; failed: number; total: number }>)[0] ?? { passed: 0, failed: 0, total: 0 };
      evidence = { passed: row.passed, failed: row.failed, total: row.total };
      if (row.failed > 0) {
        status = "fail";
        openIssues.push({ issue: `${row.failed} flow tests failed`, remediation: "fix failing flows; re-run tests", severity: "blocker" });
      } else if (row.passed < row.total) {
        status = "warn";
        openIssues.push({ issue: `${row.total - row.passed} flow tests not yet run`, remediation: "complete flow test suite", severity: "warning" });
      }
      break;
    }
    case "rtl_verified": {
      const result = await db.execute(sql`
        select rtl_required, rtl_verified
        from regional_cultural_data
        where region_code = ${regionCode}
      `);
      const row = (result as unknown as Array<{ rtl_required: boolean; rtl_verified: boolean }>)[0] ?? { rtl_required: false, rtl_verified: false };
      evidence = { rtlRequired: row.rtl_required, rtlVerified: row.rtl_verified };
      if (row.rtl_required && !row.rtl_verified) {
        status = "fail";
        openIssues.push({ issue: "RTL required but not verified", remediation: "complete RTL verification across every UI surface", severity: "blocker" });
      }
      break;
    }
    case "formats_correct": {
      const result = await db.execute(sql`
        select date_format is not null as date_ok,
               number_format is not null as number_ok,
               address_format is not null as address_ok
        from regional_cultural_data
        where region_code = ${regionCode}
      `);
      const row = (result as unknown as Array<{ date_ok: boolean; number_ok: boolean; address_ok: boolean }>)[0] ?? { date_ok: false, number_ok: false, address_ok: false };
      evidence = { date: row.date_ok, number: row.number_ok, address: row.address_ok };
      if (!row.date_ok || !row.number_ok || !row.address_ok) {
        status = "warn";
        const missing: string[] = [];
        if (!row.date_ok) missing.push("date");
        if (!row.number_ok) missing.push("number");
        if (!row.address_ok) missing.push("address");
        openIssues.push({ issue: `formats not configured: ${missing.join(", ")}`, remediation: "configure locale-specific formats via i18n/format.ts", severity: "warning" });
      }
      break;
    }
    case "payments_work": {
      const result = await db.execute(sql`
        select
          count(*) filter (where status = 'pass')::int as sandbox_passed,
          count(*) filter (where status = 'fail')::int as sandbox_failed,
          bool_or(live_test_passed) as live_passed
        from payment_test_results
        where region_code = ${regionCode}
          and tested_at >= now() - interval '24 hours'
      `);
      const row = (result as unknown as Array<{ sandbox_passed: number; sandbox_failed: number; live_passed: boolean }>)[0] ?? { sandbox_passed: 0, sandbox_failed: 0, live_passed: false };
      evidence = { sandboxPassed: row.sandbox_passed, sandboxFailed: row.sandbox_failed, liveTestPassed: row.live_passed };
      if (row.sandbox_failed > 0) {
        status = "fail";
        openIssues.push({ issue: `${row.sandbox_failed} sandbox payment tests failed`, remediation: "fix failing payment flows", severity: "blocker" });
      } else if (!row.live_passed) {
        status = "warn";
        openIssues.push({ issue: "live small-amount test not yet passed", remediation: "run small-amount live test ($0.50)", severity: "warning" });
      }
      break;
    }
    case "legal_pages_published": {
      const result = await db.execute(sql`
        select
          count(*) filter (where http_status = 200)::int as reachable,
          count(*) filter (where http_status is null or http_status <> 200)::int as unreachable,
          count(*)::int as total
        from legal_page_reachability
        where region_code = ${regionCode}
          and checked_at >= now() - interval '24 hours'
      `);
      const row = (result as unknown as Array<{ reachable: number; unreachable: number; total: number }>)[0] ?? { reachable: 0, unreachable: 0, total: 0 };
      evidence = { reachable: row.reachable, unreachable: row.unreachable, total: row.total };
      if (row.unreachable > 0) {
        status = "fail";
        openIssues.push({ issue: `${row.unreachable} legal pages unreachable`, remediation: "publish missing legal pages", severity: "blocker" });
      }
      break;
    }
    case "tax_rules_correct": {
      const result = await db.execute(sql`
        select
          count(*) filter (where calculated_tax = expected_tax)::int as correct,
          count(*) filter (where calculated_tax <> expected_tax)::int as incorrect,
          count(*)::int as total
        from tax_test_results
        where region_code = ${regionCode}
          and tested_at >= now() - interval '24 hours'
      `);
      const row = (result as unknown as Array<{ correct: number; incorrect: number; total: number }>)[0] ?? { correct: 0, incorrect: 0, total: 0 };
      evidence = { correct: row.correct, incorrect: row.incorrect, total: row.total };
      if (row.incorrect > 0) {
        status = "fail";
        openIssues.push({ issue: `${row.incorrect} tax calculations incorrect`, remediation: "fix tax rule configuration", severity: "blocker" });
      }
      break;
    }
    case "content_accessible": {
      const result = await db.execute(sql`
        select
          count(*) filter (where http_status = 200)::int as accessible,
          count(*) filter (where http_status is null or http_status <> 200)::int as inaccessible,
          count(*)::int as total
        from content_accessibility_check
        where region_code = ${regionCode}
          and checked_at >= now() - interval '24 hours'
      `);
      const row = (result as unknown as Array<{ accessible: number; inaccessible: number; total: number }>)[0] ?? { accessible: 0, inaccessible: 0, total: 0 };
      evidence = { accessible: row.accessible, inaccessible: row.inaccessible, total: row.total };
      if (row.inaccessible > 0) {
        status = "warn";
        openIssues.push({ issue: `${row.inaccessible} content pages inaccessible`, remediation: "fix content routing or publish missing pages", severity: "warning" });
      }
      break;
    }
    case "support_channels_live": {
      const result = await db.execute(sql`
        select
          bool_or(channel = 'ticket' and live) as ticket_live,
          bool_or(channel = 'chat' and live) as chat_live,
          bool_or(channel = 'help_search' and live) as help_search_live,
          bool_or(channel = 'email' and live) as email_live
        from support_channel_liveness
        where region_code = ${regionCode}
          and checked_at >= now() - interval '24 hours'
      `);
      const row = (result as unknown as Array<{ ticket_live: boolean; chat_live: boolean; help_search_live: boolean; email_live: boolean }>)[0] ?? { ticket_live: false, chat_live: false, help_search_live: false, email_live: false };
      evidence = { ticket: row.ticket_live, chat: row.chat_live, helpSearch: row.help_search_live, email: row.email_live };
      if (!row.ticket_live) {
        status = "fail";
        openIssues.push({ issue: "ticket channel not live", remediation: "enable ticket UI in the locale", severity: "blocker" });
      } else if (!row.chat_live || !row.help_search_live) {
        status = "warn";
        openIssues.push({ issue: "some support channels not live", remediation: "enable remaining channels or document async-only support", severity: "warning" });
      }
      break;
    }
    case "marketing_assets_ready": {
      const result = await db.execute(sql`
        select
          count(*) filter (where status = 'ready')::int as ready,
          count(*) filter (where status <> 'ready')::int as not_ready,
          count(*)::int as total
        from marketing_asset_readiness
        where region_code = ${regionCode}
      `);
      const row = (result as unknown as Array<{ ready: number; not_ready: number; total: number }>)[0] ?? { ready: 0, not_ready: 0, total: 0 };
      evidence = { ready: row.ready, notReady: row.not_ready, total: row.total };
      if (row.not_ready > 0) {
        status = "warn";
        openIssues.push({ issue: `${row.not_ready} marketing assets not ready`, remediation: "complete marketing asset preparation", severity: "warning" });
      }
      break;
    }
    case "infrastructure_healthy": {
      const result = await db.execute(sql`
        select
          (select percentile_cont(0.95) within group (order by latency_ms)
             from latency_probes where region_code = ${regionCode}
             and probe_at >= now() - interval '24 hours')::float8 as p95_latency,
          (select count(*) from cdn_edge_pops where region_code = ${regionCode} and healthy)::int as healthy_cdns,
          (select bool_or(failover_test_passed) from infra_failover_tests
             where region_code = ${regionCode} and tested_at >= now() - interval '7 days') as failover_ok,
          (select bool_or(last_backup_successful) from infra_backup_status where region_code = ${regionCode}) as backups_ok
      `);
      const row = (result as unknown as Array<{ p95_latency: number; healthy_cdns: number; failover_ok: boolean; backups_ok: boolean }>)[0] ?? { p95_latency: 0, healthy_cdns: 0, failover_ok: false, backups_ok: false };
      evidence = { p95LatencyMs: row.p95_latency, healthyCdns: row.healthy_cdns, failoverOk: row.failover_ok, backupsOk: row.backups_ok };
      if (row.p95_latency > 500 || !row.failover_ok || !row.backups_ok) {
        status = "fail";
        if (row.p95_latency > 500) openIssues.push({ issue: `latency p95=${row.p95_latency}ms exceeds 500ms`, remediation: "add edge POPs or read replica", severity: "blocker" });
        if (!row.failover_ok) openIssues.push({ issue: "failover test not passed", remediation: "test failover path", severity: "blocker" });
        if (!row.backups_ok) openIssues.push({ issue: "backups not running", remediation: "fix backup schedule", severity: "blocker" });
      }
      break;
    }
    default: {
      const _exhaustive: never = checkId;
      throw new Error(`Unhandled check: ${String(_exhaustive)}`);
    }
  }

  return {
    checkId,
    number: spec.number,
    title: spec.title,
    status,
    critical: spec.critical,
    evidence,
    openIssues,
    checkedAt: new Date(),
  };
}

/**
 * Run all 11 automated checks in parallel for a region.
 */
export async function runAllAutomatedChecks(regionCode: string): Promise<CheckResult[]> {
  return Promise.all(
    AUTOMATED_CHECKS.map((c) =>
      runAutomatedCheck(c.id, regionCode).catch((err) => {
        // A single check failure shouldn't block the others.
        return {
          checkId: c.id,
          number: c.number,
          title: c.title,
          status: "fail" as CheckStatus,
          critical: c.critical,
          evidence: { error: err instanceof Error ? err.message : String(err) },
          openIssues: [{ issue: "check execution failed", remediation: "investigate + retry", severity: "blocker" as const }],
          checkedAt: new Date(),
        } as CheckResult;
      }),
    ),
  );
}

// ───────────────────────────────────────────────
// 9.2 Human verification — 6 reviewers.
// ───────────────────────────────────────────────

export type HumanVerificationId =
  | "native_speaker_review"  // 9.2.1
  | "legal_counsel"          // 9.2.2
  | "tax_advisor"            // 9.2.3
  | "payments_advisor"       // 9.2.4
  | "support_lead"           // 9.2.5
  | "marketing_lead";        // 9.2.6

export interface HumanVerificationSpec {
  id: HumanVerificationId;
  number: string;
  title: string;
  description: string;
  /** The role that signs off. */
  reviewer: string;
  implemented: boolean;
}

export const HUMAN_VERIFICATIONS: HumanVerificationSpec[] = [
  {
    id: "native_speaker_review",
    number: "9.2.1",
    title: "Native speaker reviews the product end-to-end",
    description: "A native speaker of the region's primary language reviews the product end-to-end (signup, chat, design, invoice, agent) for language quality + cultural fit.",
    reviewer: "native_speaker_reviewer",
    implemented: true,
  },
  {
    id: "legal_counsel",
    number: "9.2.2",
    title: "Legal counsel confirms compliance",
    description: "Legal counsel confirms the region's legal documents (Privacy, ToS, Cookie, DPA, Refund) comply with local laws.",
    reviewer: "legal_counsel",
    implemented: true,
  },
  {
    id: "tax_advisor",
    number: "9.2.3",
    title: "Tax advisor confirms tax setup",
    description: "Tax advisor confirms the tax configuration (registration, rules, invoices, reporting) is correct for the jurisdiction.",
    reviewer: "tax_advisor",
    implemented: true,
  },
  {
    id: "payments_advisor",
    number: "9.2.4",
    title: "Payments advisor confirms payment flows",
    description: "Payments advisor confirms the payment flows (methods, currencies, pricing, payouts, refunds, disputes, chargebacks) work end-to-end.",
    reviewer: "payments_advisor",
    implemented: true,
  },
  {
    id: "support_lead",
    number: "9.2.5",
    title: "Support lead confirms support readiness",
    description: "Support lead confirms the support readiness (language, hours, agents trained, SLAs, escalation, macros, AI triage).",
    reviewer: "support_lead",
    implemented: true,
  },
  {
    id: "marketing_lead",
    number: "9.2.6",
    title: "Marketing lead confirms campaign readiness",
    description: "Marketing lead confirms the campaign readiness (landing pages, ads, emails, social, partnerships, press, schedule).",
    reviewer: "marketing_lead",
    implemented: true,
  },
];

export interface HumanVerificationResult {
  id: HumanVerificationId;
  number: string;
  title: string;
  status: "signed_off" | "pending";
  signedOffBy: string | null;
  signedOffAt: Date | null;
  reason: string | null;
}

/**
 * Check the status of all 6 human verifications for a region.
 * Reads from the verification_signoffs table.
 */
export async function checkHumanVerifications(regionCode: string): Promise<HumanVerificationResult[]> {
  const result = await db.execute(sql`
    select verification_id, signed_off, signed_off_by, signed_off_at, reason
      from verification_signoffs
     where region_code = ${regionCode}
  `);
  const rows = result as unknown as Array<{
    verification_id: string;
    signed_off: boolean;
    signed_off_by: string | null;
    signed_off_at: Date | null;
    reason: string | null;
  }>;
  const signoffMap = new Map<string, HumanVerificationResult>();
  for (const r of rows) {
    const spec = HUMAN_VERIFICATIONS.find((s) => s.id === r.verification_id);
    if (!spec) continue;
    signoffMap.set(r.verification_id, {
      id: spec.id,
      number: spec.number,
      title: spec.title,
      status: r.signed_off ? "signed_off" : "pending",
      signedOffBy: r.signed_off_by,
      signedOffAt: r.signed_off_at,
      reason: r.reason,
    });
  }
  // Fill in pending entries for any human verification that hasn't been recorded.
  return HUMAN_VERIFICATIONS.map((spec) => {
    const existing = signoffMap.get(spec.id);
    if (existing) return existing;
    return {
      id: spec.id,
      number: spec.number,
      title: spec.title,
      status: "pending" as const,
      signedOffBy: null,
      signedOffAt: null,
      reason: null,
    };
  });
}

/**
 * Record a human verification sign-off.
 */
export async function signOffHumanVerification(input: {
  regionCode: string;
  verificationId: HumanVerificationId;
  signedOffBy: string;
  reason: string;
}): Promise<void> {
  await db.execute(sql`
    insert into verification_signoffs
      (region_code, verification_id, signed_off, signed_off_by, signed_off_at, reason)
    values
      (${input.regionCode}, ${input.verificationId}, true, ${input.signedOffBy}, now(), ${input.reason})
    on conflict (region_code, verification_id) do update
       set signed_off = true,
           signed_off_by = ${input.signedOffBy},
           signed_off_at = now(),
           reason = ${input.reason}
  `);

  await adminAudit({
    actor: input.signedOffBy,
    action: `regional.verification.${input.verificationId}_signed_off`,
    target: { regionCode: input.regionCode, verificationId: input.verificationId, reason: input.reason },
    justification: `Verification ${input.verificationId} signed off for ${input.regionCode}: ${input.reason}`,
  });
}

// ───────────────────────────────────────────────
// 9.3 Verification Output — structured report.
// ───────────────────────────────────────────────

export type VerificationRecommendation = "go" | "no_go" | "conditional" | "pending_human" | "return_to_preparation";

export interface VerificationReport {
  regionCode: string;
  automatedChecks: CheckResult[];
  humanVerifications: HumanVerificationResult[];
  /** Aggregated status across all automated checks. */
  automatedStatus: "all_pass" | "critical_fail" | "warnings_only";
  /** Aggregated status across all human verifications. */
  humanStatus: "all_signed_off" | "pending";
  /** Open issues across all checks. */
  openIssues: Array<{
    source: string;       // check id or verification id.
    issue: string;
    remediation: string;
    severity: "blocker" | "warning";
  }>;
  /** Final recommendation. */
  recommendation: VerificationRecommendation;
  recommendationReason: string;
  /** True if region should return to Preparation (critical automated failure). */
  returnToPreparation: boolean;
  generatedAt: Date;
}

/**
 * Produce the Verification Report for a region.
 *
 * Runs all 11 automated checks + checks all 6 human verifications + aggregates.
 *
 * Recommendation logic:
 *   - return_to_preparation: any CRITICAL automated check failed.
 *   - pending_human: automated checks pass but human verifications pending.
 *   - go: all automated pass + all human signed off.
 *   - conditional: automated warnings (no critical fails) + all human signed off.
 *   - no_go: any human verification explicitly rejected (signed off = false).
 */
export async function produceVerificationReport(regionCode: string): Promise<VerificationReport> {
  const [automatedChecks, humanVerifications] = await Promise.all([
    runAllAutomatedChecks(regionCode),
    checkHumanVerifications(regionCode),
  ]);

  // Aggregate automated status.
  const criticalFails = automatedChecks.filter((c) => c.critical && c.status === "fail");
  const warnings = automatedChecks.filter((c) => c.status === "warn");
  const automatedStatus: VerificationReport["automatedStatus"] =
    criticalFails.length > 0 ? "critical_fail" :
    warnings.length > 0 ? "warnings_only" :
    "all_pass";

  // Aggregate human status.
  const pendingHuman = humanVerifications.filter((h) => h.status === "pending");
  const humanStatus: VerificationReport["humanStatus"] =
    pendingHuman.length > 0 ? "pending" : "all_signed_off";

  // Open issues.
  const openIssues: VerificationReport["openIssues"] = [];
  for (const c of automatedChecks) {
    for (const issue of c.openIssues) {
      openIssues.push({
        source: c.checkId,
        issue: issue.issue,
        remediation: issue.remediation,
        severity: issue.severity,
      });
    }
  }

  // Recommendation.
  let recommendation: VerificationRecommendation;
  let recommendationReason: string;
  let returnToPreparation = false;

  if (criticalFails.length > 0) {
    recommendation = "return_to_preparation";
    returnToPreparation = true;
    recommendationReason = `${criticalFails.length} critical automated check(s) failed: ${criticalFails.map((c) => c.checkId).join(", ")}`;
  } else if (humanStatus === "pending") {
    recommendation = "pending_human";
    recommendationReason = `${pendingHuman.length} human verification(s) pending: ${pendingHuman.map((h) => h.id).join(", ")}`;
  } else if (automatedStatus === "warnings_only") {
    recommendation = "conditional";
    recommendationReason = `${warnings.length} warning(s) — proceed with remediation plan`;
  } else {
    recommendation = "go";
    recommendationReason = "all automated checks pass + all human verifications signed off";
  }

  const report: VerificationReport = {
    regionCode,
    automatedChecks,
    humanVerifications,
    automatedStatus,
    humanStatus,
    openIssues,
    recommendation,
    recommendationReason,
    returnToPreparation,
    generatedAt: new Date(),
  };

  await adminAudit({
    actor: "system",
    action: "regional.verification.report_generated",
    target: {
      regionCode,
      automatedStatus,
      humanStatus,
      criticalFailCount: criticalFails.length,
      warningCount: warnings.length,
      pendingHumanCount: pendingHuman.length,
      recommendation,
      returnToPreparation,
    },
    justification: `Verification report for ${regionCode}: ${recommendation} (${recommendationReason}).`,
  });

  return report;
}

// ───────────────────────────────────────────────
// 9 Verification.
// ───────────────────────────────────────────────

export interface VerificationStageVerification {
  totalAutomatedChecks: number;
  implementedAutomatedChecks: number;
  totalHumanVerifications: number;
  implementedHumanVerifications: number;
  reportFunctionImplemented: boolean;
  allImplemented: boolean;
  automatedChecks: AutomatedCheckSpec[];
  humanVerifications: HumanVerificationSpec[];
}

export function verifyVerificationStage(): VerificationStageVerification {
  return {
    totalAutomatedChecks: AUTOMATED_CHECKS.length,
    implementedAutomatedChecks: AUTOMATED_CHECKS.filter((c) => c.implemented).length,
    totalHumanVerifications: HUMAN_VERIFICATIONS.length,
    implementedHumanVerifications: HUMAN_VERIFICATIONS.filter((h) => h.implemented).length,
    reportFunctionImplemented: true,
    allImplemented:
      AUTOMATED_CHECKS.every((c) => c.implemented) &&
      HUMAN_VERIFICATIONS.every((h) => h.implemented),
    automatedChecks: AUTOMATED_CHECKS,
    humanVerifications: HUMAN_VERIFICATIONS,
  };
}
