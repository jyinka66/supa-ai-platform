/**
 * Regional Expansion Playbook — Sections 1-3 — tests.
 *
 * Verifies the spec:
 *   1. Purpose — autonomous, safe, compliant, global-scale regional expansion.
 *   2. Region definition — 10 components; active = all 10 provisioned + verified.
 *   3. Principles — 9 principles (demand-driven, threshold-based, ...).
 */

import { describe, it, expect } from "vitest";
import {
  REGION_COMPONENTS,
  EXPANSION_PRINCIPLES,
  verifyRegionalPlaybook,
  getRegionComponent,
  getExpansionPrinciple,
  type RegionComponent,
  type ExpansionPrinciple,
  type RegionComponentSpec,
  type ExpansionPrincipleSpec,
  type RegionDefinition,
  type DemandSignal,
} from "@/lib/expansion/regional-expansion-playbook";

// ───────────────────────────────────────────────
// 2. Region components — 10 components
// ───────────────────────────────────────────────

describe("2 — Region components (what a region means)", () => {
  it("has 10 components", () => {
    expect(REGION_COMPONENTS).toHaveLength(10);
    const components = REGION_COMPONENTS.map((c) => c.component);
    expect(components).toContain("countries");
    expect(components).toContain("languages");
    expect(components).toContain("currencies");
    expect(components).toContain("payment_methods");
    expect(components).toContain("tax_regime");
    expect(components).toContain("legal_jurisdiction");
    expect(components).toContain("data_residency");
    expect(components).toContain("support_hours");
    expect(components).toContain("content");
    expect(components).toContain("culture");
  });

  it("all 10 components are implemented + have a verifier", () => {
    const v = verifyRegionalPlaybook();
    expect(v.implementedComponents).toBe(10);
    expect(v.totalComponents).toBe(10);
    for (const c of REGION_COMPONENTS) {
      expect(c.implemented).toBe(true);
      expect(c.verifier.length).toBeGreaterThan(0);
    }
  });

  it("2.1 countries — one or more countries sharing characteristics", () => {
    const c = getRegionComponent("countries");
    expect(c?.title).toBe("Countries");
    expect(c?.description).toContain("share");
    expect(c?.description).toContain("language");
    expect(c?.description).toContain("currency");
    expect(c?.description).toContain("legal");
    expect(c?.description).toContain("payment");
    expect(c?.implemented).toBe(true);
  });

  it("2.2 languages — one or more with priority order", () => {
    const c = getRegionComponent("languages");
    expect(c?.title).toBe("Languages");
    expect(c?.description).toContain("priority order");
    expect(c?.implemented).toBe(true);
  });

  it("2.3 currencies — primary and secondary", () => {
    const c = getRegionComponent("currencies");
    expect(c?.title).toBe("Currencies");
    expect(c?.description).toContain("Primary and secondary");
    expect(c?.implemented).toBe(true);
  });

  it("2.4 payment methods — cards, bank transfer, mobile money, wallets, COD", () => {
    const c = getRegionComponent("payment_methods");
    expect(c?.title).toBe("Payment Methods");
    expect(c?.description).toContain("Cards");
    expect(c?.description).toContain("bank transfer");
    expect(c?.description).toContain("mobile money");
    expect(c?.description).toContain("wallets");
    expect(c?.description.toLowerCase()).toContain("cash-on-delivery");
    expect(c?.implemented).toBe(true);
  });

  it("2.5 tax regime — VAT, GST, sales tax, or none", () => {
    const c = getRegionComponent("tax_regime");
    expect(c?.title).toBe("Tax Regime");
    expect(c?.description).toContain("VAT");
    expect(c?.description).toContain("GST");
    expect(c?.description).toContain("sales tax");
    expect(c?.description).toContain("none");
    expect(c?.implemented).toBe(true);
  });

  it("2.6 legal jurisdiction — privacy, consumer protection, data residency, content rules", () => {
    const c = getRegionComponent("legal_jurisdiction");
    expect(c?.title).toBe("Legal Jurisdiction");
    expect(c?.description).toContain("Privacy");
    expect(c?.description).toContain("consumer protection");
    expect(c?.description).toContain("data residency");
    expect(c?.description).toContain("content");
    expect(c?.implemented).toBe(true);
  });

  it("2.7 data residency — where user data is stored and processed", () => {
    const c = getRegionComponent("data_residency");
    expect(c?.title).toBe("Data Residency");
    expect(c?.description).toContain("stored and processed");
    expect(c?.implemented).toBe(true);
  });

  it("2.8 support hours — when support is available, in which languages", () => {
    const c = getRegionComponent("support_hours");
    expect(c?.title).toBe("Support Hours");
    expect(c?.description).toContain("available");
    expect(c?.description).toContain("languages");
    expect(c?.implemented).toBe(true);
  });

  it("2.9 content — localized marketing, help center, blog, legal", () => {
    const c = getRegionComponent("content");
    expect(c?.title).toBe("Content");
    expect(c?.description).toContain("marketing");
    expect(c?.description).toContain("help center");
    expect(c?.description).toContain("blog");
    expect(c?.description).toContain("legal");
    expect(c?.implemented).toBe(true);
  });

  it("2.10 culture — date formats, name order, addressing, RTL/LTR, imagery", () => {
    const c = getRegionComponent("culture");
    expect(c?.title).toBe("Culture");
    expect(c?.description.toLowerCase()).toContain("date formats");
    expect(c?.description).toContain("name order");
    expect(c?.description).toContain("addressing");
    expect(c?.description).toContain("RTL");
    expect(c?.description).toContain("imagery");
    expect(c?.implemented).toBe(true);
  });

  it("RegionComponent is the union of 10 named components", () => {
    const c1: RegionComponent = "countries";
    const c2: RegionComponent = "languages";
    const c3: RegionComponent = "currencies";
    const c4: RegionComponent = "payment_methods";
    const c5: RegionComponent = "tax_regime";
    const c6: RegionComponent = "legal_jurisdiction";
    const c7: RegionComponent = "data_residency";
    const c8: RegionComponent = "support_hours";
    const c9: RegionComponent = "content";
    const c10: RegionComponent = "culture";
    expect([c1, c2, c3, c4, c5, c6, c7, c8, c9, c10]).toHaveLength(10);
  });
});

// ───────────────────────────────────────────────
// 3. Principles — 9 principles
// ───────────────────────────────────────────────

describe("3 — Principles (9 principles)", () => {
  it("has 9 principles", () => {
    expect(EXPANSION_PRINCIPLES).toHaveLength(9);
    const principles = EXPANSION_PRINCIPLES.map((p) => p.principle);
    expect(principles).toContain("demand_driven");
    expect(principles).toContain("threshold_based");
    expect(principles).toContain("playbook_driven");
    expect(principles).toContain("compliance_gated");
    expect(principles).toContain("quality_gated");
    expect(principles).toContain("autonomous_where_safe");
    expect(principles).toContain("reversible");
    expect(principles).toContain("observable");
    expect(principles).toContain("users_first");
  });

  it("all 9 principles are implemented + have enforcedBy", () => {
    const v = verifyRegionalPlaybook();
    expect(v.implementedPrinciples).toBe(9);
    expect(v.totalPrinciples).toBe(9);
    for (const p of EXPANSION_PRINCIPLES) {
      expect(p.implemented).toBe(true);
      expect(p.enforcedBy.length).toBeGreaterThan(0);
    }
  });

  it("3.1 demand-driven — regions launch when there is real, measured demand", () => {
    const p = getExpansionPrinciple("demand_driven");
    expect(p?.title).toBe("Demand-driven");
    expect(p?.description).toContain("real, measured demand");
    expect(p?.enforcedBy.some((e) => e.includes("Demand signal collection"))).toBe(true);
    expect(p?.enforcedBy.some((e) => e.includes("checkThreshold"))).toBe(true);
    expect(p?.implemented).toBe(true);
  });

  it("3.2 threshold-based — activation thresholds for users/signups/revenue/traffic", () => {
    const p = getExpansionPrinciple("threshold_based");
    expect(p?.title).toBe("Threshold-based");
    expect(p?.description).toContain("users");
    expect(p?.description).toContain("signups");
    expect(p?.description).toContain("revenue");
    expect(p?.description).toContain("traffic");
    expect(p?.enforcedBy.some((e) => e.includes("EXPANSION_THRESHOLDS"))).toBe(true);
    expect(p?.enforcedBy.some((e) => e.includes("checkThreshold"))).toBe(true);
    expect(p?.implemented).toBe(true);
  });

  it("3.3 playbook-driven — same playbook for every region", () => {
    const p = getExpansionPrinciple("playbook_driven");
    expect(p?.title).toBe("Playbook-driven");
    expect(p?.description).toContain("same playbook");
    expect(p?.description).toContain("region 20");
    expect(p?.description).toContain("region 2");
    expect(p?.enforcedBy.some((e) => e.includes("REGION_COMPONENTS"))).toBe(true);
    expect(p?.enforcedBy.some((e) => e.includes("regional/service.ts"))).toBe(true);
    expect(p?.enforcedBy.some((e) => e.includes("expansion/pipeline.ts"))).toBe(true);
    expect(p?.implemented).toBe(true);
  });

  it("3.4 compliance-gated — no launch without legal/tax/data residency compliance", () => {
    const p = getExpansionPrinciple("compliance_gated");
    expect(p?.title).toBe("Compliance-gated");
    expect(p?.description).toContain("legal");
    expect(p?.description).toContain("tax");
    expect(p?.description).toContain("data residency");
    expect(p?.enforcedBy.some((e) => e.includes("checkComplianceGate"))).toBe(true);
    expect(p?.enforcedBy.some((e) => e.includes("legal/service.ts"))).toBe(true);
    expect(p?.implemented).toBe(true);
  });

  it("3.5 quality-gated — no launch without native-speaker review", () => {
    const p = getExpansionPrinciple("quality_gated");
    expect(p?.title).toBe("Quality-gated");
    expect(p?.description).toContain("native-speaker review");
    expect(p?.enforcedBy.some((e) => e.includes("expansion/pipeline.ts"))).toBe(true);
    expect(p?.enforcedBy.some((e) => e.includes("scheduleNativeSpeakerReviews"))).toBe(true);
    expect(p?.enforcedBy.some((e) => e.includes("i18n/checker.ts"))).toBe(true);
    expect(p?.implemented).toBe(true);
  });

  it("3.6 autonomous where safe — automated where safe, human-reviewed where not", () => {
    const p = getExpansionPrinciple("autonomous_where_safe");
    expect(p?.title).toBe("Autonomous where safe");
    expect(p?.description).toContain("automated");
    expect(p?.description).toContain("human-reviewed");
    expect(p?.enforcedBy.some((e) => e.includes("regional/service.ts"))).toBe(true);
    expect(p?.enforcedBy.some((e) => e.includes("decision-engine.ts"))).toBe(true);
    expect(p?.enforcedBy.some((e) => e.includes("risk-levels.ts"))).toBe(true);
    expect(p?.enforcedBy.some((e) => e.includes("ethics.ts"))).toBe(true);
    expect(p?.implemented).toBe(true);
  });

  it("3.7 reversible — every rollout has a rollback path", () => {
    const p = getExpansionPrinciple("reversible");
    expect(p?.title).toBe("Reversible");
    expect(p?.description).toContain("rollback path");
    expect(p?.description).toContain("paused or retired");
    expect(p?.description).toContain("without affecting others");
    expect(p?.enforcedBy.some((e) => e.includes("rollback.ts"))).toBe(true);
    expect(p?.enforcedBy.some((e) => e.includes("rollbackAllowed"))).toBe(true);
    expect(p?.enforcedBy.some((e) => e.includes("kill-switches.ts"))).toBe(true);
    expect(p?.implemented).toBe(true);
  });

  it("3.8 observable — every stage measured, logged, auditable", () => {
    const p = getExpansionPrinciple("observable");
    expect(p?.title).toBe("Observable");
    expect(p?.description).toContain("measured");
    expect(p?.description).toContain("logged");
    expect(p?.description).toContain("auditable");
    expect(p?.enforcedBy.some((e) => e.includes("governance-metrics.ts"))).toBe(true);
    expect(p?.enforcedBy.some((e) => e.includes("governance-decision-log.ts"))).toBe(true);
    expect(p?.enforcedBy.some((e) => e.includes("governance-dashboards.ts"))).toBe(true);
    expect(p?.enforcedBy.some((e) => e.includes("governance-audit-trail.ts"))).toBe(true);
    expect(p?.implemented).toBe(true);
  });

  it("3.9 users first — first-class experience, not just a launch checkbox", () => {
    const p = getExpansionPrinciple("users_first");
    expect(p?.title).toBe("Users first");
    expect(p?.description).toContain("first-class experience");
    expect(p?.enforcedBy.some((e) => e.includes("expansion/pipeline.ts"))).toBe(true);
    expect(p?.enforcedBy.some((e) => e.includes("PPP pricing"))).toBe(true);
    expect(p?.enforcedBy.some((e) => e.includes("cross-regional fairness"))).toBe(true);
    expect(p?.enforcedBy.some((e) => e.includes("support_hours"))).toBe(true);
    expect(p?.implemented).toBe(true);
  });

  it("ExpansionPrinciple is the union of 9 named principles", () => {
    const p1: ExpansionPrinciple = "demand_driven";
    const p2: ExpansionPrinciple = "threshold_based";
    const p3: ExpansionPrinciple = "playbook_driven";
    const p4: ExpansionPrinciple = "compliance_gated";
    const p5: ExpansionPrinciple = "quality_gated";
    const p6: ExpansionPrinciple = "autonomous_where_safe";
    const p7: ExpansionPrinciple = "reversible";
    const p8: ExpansionPrinciple = "observable";
    const p9: ExpansionPrinciple = "users_first";
    expect([p1, p2, p3, p4, p5, p6, p7, p8, p9]).toHaveLength(9);
  });
});

// ───────────────────────────────────────────────
// 1-3 Overall verification
// ───────────────────────────────────────────────

describe("1-3 — Overall playbook verification", () => {
  it("verifyRegionalPlaybook() reports all sections implemented", () => {
    const v = verifyRegionalPlaybook();
    expect(v.allImplemented).toBe(true);
    expect(v.totalComponents).toBe(10);
    expect(v.implementedComponents).toBe(10);
    expect(v.totalPrinciples).toBe(9);
    expect(v.implementedPrinciples).toBe(9);
  });

  it("RegionComponentSpec is a structured type", () => {
    const c: RegionComponentSpec = {
      component: "culture",
      title: "Test",
      description: "test",
      verifier: "test",
      implemented: true,
    };
    expect(c.component).toBe("culture");
    expect(c.implemented).toBe(true);
  });

  it("ExpansionPrincipleSpec is a structured type", () => {
    const p: ExpansionPrincipleSpec = {
      principle: "observable",
      title: "Test",
      description: "test",
      enforcedBy: ["test"],
      implemented: true,
    };
    expect(p.principle).toBe("observable");
    expect(p.implemented).toBe(true);
  });

  it("RegionDefinition type has the expected shape", () => {
    const r: RegionDefinition = {
      regionCode: "us",
      displayName: "United States",
      components: [
        { component: "countries", provisioned: true, verified: true },
        { component: "languages", provisioned: true, verified: true },
      ],
      active: true,
    };
    expect(r.regionCode).toBe("us");
    expect(r.active).toBe(true);
    expect(r.components).toHaveLength(2);
  });

  it("DemandSignal type has the expected shape", () => {
    const d: DemandSignal = {
      regionCode: "us",
      signupAttempts: 1500,
      organicSessions: 5000,
      supportTickets: 12,
      demandScore: 1500 + 6 + 500,
      thresholdMet: true,
      remaining: 0,
    };
    expect(d.regionCode).toBe("us");
    expect(d.thresholdMet).toBe(true);
    expect(d.demandScore).toBeGreaterThan(1500);
  });
});
