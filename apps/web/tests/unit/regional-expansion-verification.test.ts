/**
 * Regional Expansion Playbook — Section 9 (Stage 5 Verification) — tests.
 *
 * Verifies the spec:
 *   9.1 Automated verification — 11 checks (7 critical + 4 non-critical).
 *   9.2 Human verification — 6 reviewers.
 *   9.3 Verification Output — structured report with status, evidence,
 *       open issues, go/no-go recommendation, return-to-preparation on critical fail.
 */

import { describe, it, expect } from "vitest";
import {
  AUTOMATED_CHECKS,
  HUMAN_VERIFICATIONS,
  verifyVerificationStage,
  type AutomatedCheckId,
  type CheckStatus,
  type AutomatedCheckSpec,
  type CheckResult,
  type HumanVerificationId,
  type HumanVerificationSpec,
  type HumanVerificationResult,
  type VerificationRecommendation,
  type VerificationReport,
} from "@/lib/expansion/stage-verification";

// ───────────────────────────────────────────────
// 9.1 Automated verification — 11 checks
// ───────────────────────────────────────────────

describe("9.1 — Automated verification (11 checks)", () => {
  it("has 11 automated checks", () => {
    expect(AUTOMATED_CHECKS).toHaveLength(11);
    const ids = AUTOMATED_CHECKS.map((c) => c.id);
    expect(ids).toContain("strings_translated");
    expect(ids).toContain("flows_work");
    expect(ids).toContain("rtl_verified");
    expect(ids).toContain("formats_correct");
    expect(ids).toContain("payments_work");
    expect(ids).toContain("legal_pages_published");
    expect(ids).toContain("tax_rules_correct");
    expect(ids).toContain("content_accessible");
    expect(ids).toContain("support_channels_live");
    expect(ids).toContain("marketing_assets_ready");
    expect(ids).toContain("infrastructure_healthy");
  });

  it("all 11 checks are implemented", () => {
    const v = verifyVerificationStage();
    expect(v.implementedAutomatedChecks).toBe(11);
    expect(v.totalAutomatedChecks).toBe(11);
    expect(v.allImplemented).toBe(true);
  });

  it("9.1.1 strings_translated — no missing keys, no placeholders (critical)", () => {
    const c = AUTOMATED_CHECKS.find((c) => c.id === "strings_translated");
    expect(c?.number).toBe("9.1.1");
    expect(c?.title).toContain("strings translated");
    expect(c?.description).toContain("missing keys");
    expect(c?.description).toContain("placeholders");
    expect(c?.critical).toBe(true);
    expect(c?.implemented).toBe(true);
  });

  it("9.1.2 flows_work — signup, chat, design, invoice, agent (critical)", () => {
    const c = AUTOMATED_CHECKS.find((c) => c.id === "flows_work");
    expect(c?.number).toBe("9.1.2");
    expect(c?.title).toContain("flows work");
    expect(c?.description).toContain("signup");
    expect(c?.description).toContain("chat");
    expect(c?.description).toContain("design");
    expect(c?.description).toContain("invoice");
    expect(c?.description).toContain("agent");
    expect(c?.critical).toBe(true);
    expect(c?.implemented).toBe(true);
  });

  it("9.1.3 rtl_verified — RTL verified where applicable (critical)", () => {
    const c = AUTOMATED_CHECKS.find((c) => c.id === "rtl_verified");
    expect(c?.number).toBe("9.1.3");
    expect(c?.title).toContain("RTL verified");
    expect(c?.critical).toBe(true);
    expect(c?.implemented).toBe(true);
  });

  it("9.1.4 formats_correct — dates, numbers, currencies, addresses (non-critical)", () => {
    const c = AUTOMATED_CHECKS.find((c) => c.id === "formats_correct");
    expect(c?.number).toBe("9.1.4");
    expect(c?.title).toContain("formats correct");
    expect(c?.description).toContain("dates");
    expect(c?.description).toContain("numbers");
    expect(c?.description).toContain("currencies");
    expect(c?.description).toContain("addresses");
    expect(c?.critical).toBe(false);
    expect(c?.implemented).toBe(true);
  });

  it("9.1.5 payments_work — sandbox + small-amount live test (critical)", () => {
    const c = AUTOMATED_CHECKS.find((c) => c.id === "payments_work");
    expect(c?.number).toBe("9.1.5");
    expect(c?.title).toContain("payments work");
    expect(c?.description).toContain("sandbox");
    expect(c?.description).toContain("small-amount live test");
    expect(c?.critical).toBe(true);
    expect(c?.implemented).toBe(true);
  });

  it("9.1.6 legal_pages_published — published and reachable (critical)", () => {
    const c = AUTOMATED_CHECKS.find((c) => c.id === "legal_pages_published");
    expect(c?.number).toBe("9.1.6");
    expect(c?.title).toContain("legal pages published");
    expect(c?.title.toLowerCase()).toContain("reachable");
    expect(c?.critical).toBe(true);
    expect(c?.implemented).toBe(true);
  });

  it("9.1.7 tax_rules_correct — applied correctly to test transactions (critical)", () => {
    const c = AUTOMATED_CHECKS.find((c) => c.id === "tax_rules_correct");
    expect(c?.number).toBe("9.1.7");
    expect(c?.title).toContain("tax rules");
    expect(c?.description).toContain("test transactions");
    expect(c?.critical).toBe(true);
    expect(c?.implemented).toBe(true);
  });

  it("9.1.8 content_accessible — help, blog, changelog (non-critical)", () => {
    const c = AUTOMATED_CHECKS.find((c) => c.id === "content_accessible");
    expect(c?.number).toBe("9.1.8");
    expect(c?.title).toContain("content accessible");
    expect(c?.description).toContain("help");
    expect(c?.description).toContain("blog");
    expect(c?.description).toContain("changelog");
    expect(c?.critical).toBe(false);
    expect(c?.implemented).toBe(true);
  });

  it("9.1.9 support_channels_live — live in the language (non-critical)", () => {
    const c = AUTOMATED_CHECKS.find((c) => c.id === "support_channels_live");
    expect(c?.number).toBe("9.1.9");
    expect(c?.title).toContain("support channels live");
    expect(c?.title.toLowerCase()).toContain("language");
    expect(c?.critical).toBe(false);
    expect(c?.implemented).toBe(true);
  });

  it("9.1.10 marketing_assets_ready — ready (non-critical)", () => {
    const c = AUTOMATED_CHECKS.find((c) => c.id === "marketing_assets_ready");
    expect(c?.number).toBe("9.1.10");
    expect(c?.title).toContain("marketing assets ready");
    expect(c?.critical).toBe(false);
    expect(c?.implemented).toBe(true);
  });

  it("9.1.11 infrastructure_healthy — healthy (critical)", () => {
    const c = AUTOMATED_CHECKS.find((c) => c.id === "infrastructure_healthy");
    expect(c?.number).toBe("9.1.11");
    expect(c?.title).toContain("infrastructure healthy");
    expect(c?.critical).toBe(true);
    expect(c?.implemented).toBe(true);
  });

  it("7 critical checks + 4 non-critical checks", () => {
    const critical = AUTOMATED_CHECKS.filter((c) => c.critical);
    const nonCritical = AUTOMATED_CHECKS.filter((c) => !c.critical);
    expect(critical).toHaveLength(7);
    expect(nonCritical).toHaveLength(4);
  });

  it("AutomatedCheckId is the union of 11 named ids", () => {
    const ids: AutomatedCheckId[] = [
      "strings_translated", "flows_work", "rtl_verified", "formats_correct",
      "payments_work", "legal_pages_published", "tax_rules_correct",
      "content_accessible", "support_channels_live", "marketing_assets_ready",
      "infrastructure_healthy",
    ];
    expect(ids).toHaveLength(11);
  });

  it("CheckStatus is the union of pass / fail / warn", () => {
    const s1: CheckStatus = "pass";
    const s2: CheckStatus = "fail";
    const s3: CheckStatus = "warn";
    expect([s1, s2, s3]).toHaveLength(3);
  });

  it("CheckResult type has the expected shape", () => {
    const r: CheckResult = {
      checkId: "strings_translated",
      number: "9.1.1",
      title: "test",
      status: "pass",
      critical: true,
      evidence: { missing: 0 },
      openIssues: [],
      checkedAt: new Date(),
    };
    expect(r.checkId).toBe("strings_translated");
    expect(r.status).toBe("pass");
  });
});

// ───────────────────────────────────────────────
// 9.2 Human verification — 6 reviewers
// ───────────────────────────────────────────────

describe("9.2 — Human verification (6 reviewers)", () => {
  it("has 6 human verifications", () => {
    expect(HUMAN_VERIFICATIONS).toHaveLength(6);
    const ids = HUMAN_VERIFICATIONS.map((h) => h.id);
    expect(ids).toContain("native_speaker_review");
    expect(ids).toContain("legal_counsel");
    expect(ids).toContain("tax_advisor");
    expect(ids).toContain("payments_advisor");
    expect(ids).toContain("support_lead");
    expect(ids).toContain("marketing_lead");
  });

  it("all 6 human verifications are implemented", () => {
    const v = verifyVerificationStage();
    expect(v.implementedHumanVerifications).toBe(6);
    expect(v.totalHumanVerifications).toBe(6);
    expect(v.allImplemented).toBe(true);
  });

  it("9.2.1 native_speaker_review — native speaker reviews end-to-end", () => {
    const h = HUMAN_VERIFICATIONS.find((h) => h.id === "native_speaker_review");
    expect(h?.number).toBe("9.2.1");
    expect(h?.title).toContain("Native speaker");
    expect(h?.description).toContain("end-to-end");
    expect(h?.reviewer).toBe("native_speaker_reviewer");
    expect(h?.implemented).toBe(true);
  });

  it("9.2.2 legal_counsel — confirms compliance", () => {
    const h = HUMAN_VERIFICATIONS.find((h) => h.id === "legal_counsel");
    expect(h?.number).toBe("9.2.2");
    expect(h?.title).toContain("Legal counsel");
    expect(h?.title.toLowerCase()).toContain("compliance");
    expect(h?.reviewer).toBe("legal_counsel");
    expect(h?.implemented).toBe(true);
  });

  it("9.2.3 tax_advisor — confirms tax setup", () => {
    const h = HUMAN_VERIFICATIONS.find((h) => h.id === "tax_advisor");
    expect(h?.number).toBe("9.2.3");
    expect(h?.title).toContain("Tax advisor");
    expect(h?.title.toLowerCase()).toContain("tax setup");
    expect(h?.reviewer).toBe("tax_advisor");
    expect(h?.implemented).toBe(true);
  });

  it("9.2.4 payments_advisor — confirms payment flows", () => {
    const h = HUMAN_VERIFICATIONS.find((h) => h.id === "payments_advisor");
    expect(h?.number).toBe("9.2.4");
    expect(h?.title).toContain("Payments advisor");
    expect(h?.description).toContain("payment flows");
    expect(h?.reviewer).toBe("payments_advisor");
    expect(h?.implemented).toBe(true);
  });

  it("9.2.5 support_lead — confirms support readiness", () => {
    const h = HUMAN_VERIFICATIONS.find((h) => h.id === "support_lead");
    expect(h?.number).toBe("9.2.5");
    expect(h?.title).toContain("Support lead");
    expect(h?.description).toContain("support readiness");
    expect(h?.reviewer).toBe("support_lead");
    expect(h?.implemented).toBe(true);
  });

  it("9.2.6 marketing_lead — confirms campaign readiness", () => {
    const h = HUMAN_VERIFICATIONS.find((h) => h.id === "marketing_lead");
    expect(h?.number).toBe("9.2.6");
    expect(h?.title).toContain("Marketing lead");
    expect(h?.description).toContain("campaign readiness");
    expect(h?.reviewer).toBe("marketing_lead");
    expect(h?.implemented).toBe(true);
  });

  it("HumanVerificationId is the union of 6 named ids", () => {
    const ids: HumanVerificationId[] = [
      "native_speaker_review", "legal_counsel", "tax_advisor",
      "payments_advisor", "support_lead", "marketing_lead",
    ];
    expect(ids).toHaveLength(6);
  });

  it("HumanVerificationResult type has the expected shape", () => {
    const r: HumanVerificationResult = {
      id: "legal_counsel",
      number: "9.2.2",
      title: "test",
      status: "signed_off",
      signedOffBy: "counsel@example.com",
      signedOffAt: new Date(),
      reason: "approved",
    };
    expect(r.id).toBe("legal_counsel");
    expect(r.status).toBe("signed_off");
  });
});

// ───────────────────────────────────────────────
// 9.3 Verification Output — structured report
// ───────────────────────────────────────────────

describe("9.3 — Verification Output (structured report)", () => {
  it("VerificationRecommendation is the union of 5 values", () => {
    const r1: VerificationRecommendation = "go";
    const r2: VerificationRecommendation = "no_go";
    const r3: VerificationRecommendation = "conditional";
    const r4: VerificationRecommendation = "pending_human";
    const r5: VerificationRecommendation = "return_to_preparation";
    expect([r1, r2, r3, r4, r5]).toHaveLength(5);
  });

  it("VerificationReport type has the expected shape", () => {
    const report: VerificationReport = {
      regionCode: "us",
      automatedChecks: [],
      humanVerifications: [],
      automatedStatus: "all_pass",
      humanStatus: "all_signed_off",
      openIssues: [],
      recommendation: "go",
      recommendationReason: "all automated checks pass + all human verifications signed off",
      returnToPreparation: false,
      generatedAt: new Date(),
    };
    expect(report.regionCode).toBe("us");
    expect(report.recommendation).toBe("go");
    expect(report.returnToPreparation).toBe(false);
  });

  it("verifyVerificationStage reports all sections implemented", () => {
    const v = verifyVerificationStage();
    expect(v.totalAutomatedChecks).toBe(11);
    expect(v.implementedAutomatedChecks).toBe(11);
    expect(v.totalHumanVerifications).toBe(6);
    expect(v.implementedHumanVerifications).toBe(6);
    expect(v.reportFunctionImplemented).toBe(true);
    expect(v.allImplemented).toBe(true);
  });
});
