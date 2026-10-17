/**
 * Regional Expansion Playbook — Section 7 (Stage 3 Prioritization) +
 * Section 8 (Stage 4 Preparation: 8.1 Language, 8.2 Content, 8.3 Legal) — tests.
 */

import { describe, it, expect } from "vitest";
import {
  PRIORITY_FACTORS,
  DEFAULT_SCORE_WEIGHTS,
  verifyPrioritizationStage,
  type PriorityFactor,
  type PriorityFactorSpec,
  type ScoreWeights,
  type FactorScore,
  type PriorityScoreResult,
  type QueueEntry,
  type OverrideAction,
  type OverrideInput,
} from "@/lib/expansion/stage-prioritization";
import {
  LANGUAGE_WORKSTREAM,
  CONTENT_WORKSTREAM,
  LEGAL_WORKSTREAM,
  TAX_WORKSTREAM,
  PAYMENTS_WORKSTREAM,
  INFRASTRUCTURE_WORKSTREAM,
  SUPPORT_WORKSTREAM,
  MARKETING_WORKSTREAM,
  CULTURAL_WORKSTREAM,
  PREPARATION_WORKSTREAMS,
  verifyPreparationStage,
  getWorkstream,
  type WorkstreamId,
  type StepMode,
  type StepSpec,
  type StepResult,
  type WorkstreamResult,
  type WorkstreamSpec,
} from "@/lib/expansion/stage-preparation";

// ───────────────────────────────────────────────
// 7. Stage 3 — Prioritization
// ───────────────────────────────────────────────

describe("7 — Stage 3 Prioritization", () => {
  it("has 7 priority factors", () => {
    expect(PRIORITY_FACTORS).toHaveLength(7);
    const factors = PRIORITY_FACTORS.map((f) => f.factor);
    expect(factors).toContain("demand");
    expect(factors).toContain("market_size");
    expect(factors).toContain("revenue_potential");
    expect(factors).toContain("readiness");
    expect(factors).toContain("cost_to_launch");
    expect(factors).toContain("strategic_value");
    expect(factors).toContain("risk");
  });

  it("all 7 factors are implemented + have a weight + source", () => {
    const v = verifyPrioritizationStage();
    expect(v.implementedFactors).toBe(7);
    expect(v.totalFactors).toBe(7);
    expect(v.allImplemented).toBe(true);
    for (const f of PRIORITY_FACTORS) {
      expect(f.implemented).toBe(true);
      expect(f.defaultWeight).toBeGreaterThan(0);
      expect(f.defaultWeight).toBeLessThanOrEqual(1);
      expect(f.source.length).toBeGreaterThan(0);
    }
  });

  it("7.1.1 demand — measured signals", () => {
    const f = PRIORITY_FACTORS.find((f) => f.factor === "demand");
    expect(f?.title).toBe("Demand");
    expect(f?.description).toContain("signals");
    expect(f?.inverse).toBe(false);
    expect(f?.defaultWeight).toBe(0.20);
    expect(f?.implemented).toBe(true);
  });

  it("7.1.2 market_size — population, freelancers, SMBs, enterprises", () => {
    const f = PRIORITY_FACTORS.find((f) => f.factor === "market_size");
    expect(f?.title).toBe("Market Size");
    expect(f?.description).toContain("Population");
    expect(f?.description).toContain("freelancer");
    expect(f?.description).toContain("small business");
    expect(f?.description).toContain("enterprise");
    expect(f?.inverse).toBe(false);
    expect(f?.defaultWeight).toBe(0.15);
    expect(f?.implemented).toBe(true);
  });

  it("7.1.3 revenue_potential — ARPU, willingness to pay, payment reach", () => {
    const f = PRIORITY_FACTORS.find((f) => f.factor === "revenue_potential");
    expect(f?.title).toBe("Revenue Potential");
    expect(f?.description).toContain("ARPU");
    expect(f?.description).toContain("willingness to pay");
    expect(f?.description).toContain("payment");
    expect(f?.inverse).toBe(false);
    expect(f?.defaultWeight).toBe(0.20);
    expect(f?.implemented).toBe(true);
  });

  it("7.1.4 readiness — how much preparation is required", () => {
    const f = PRIORITY_FACTORS.find((f) => f.factor === "readiness");
    expect(f?.title).toBe("Readiness");
    expect(f?.description).toContain("preparation");
    expect(f?.inverse).toBe(false); // readiness is already 0-100; high = good.
    expect(f?.defaultWeight).toBe(0.15);
    expect(f?.implemented).toBe(true);
  });

  it("7.1.5 cost_to_launch — localization, legal, infra, support (inverse)", () => {
    const f = PRIORITY_FACTORS.find((f) => f.factor === "cost_to_launch");
    expect(f?.title).toBe("Cost to Launch");
    expect(f?.description.toLowerCase()).toContain("localization");
    expect(f?.description.toLowerCase()).toContain("legal");
    expect(f?.description.toLowerCase()).toContain("infrastructure");
    expect(f?.description.toLowerCase()).toContain("support");
    expect(f?.inverse).toBe(true); // high cost = low contribution.
    expect(f?.defaultWeight).toBe(0.10);
    expect(f?.implemented).toBe(true);
  });

  it("7.1.6 strategic_value — regional influence, language leverage, competitive positioning", () => {
    const f = PRIORITY_FACTORS.find((f) => f.factor === "strategic_value");
    expect(f?.title).toBe("Strategic Value");
    expect(f?.description.toLowerCase()).toContain("regional influence");
    expect(f?.description.toLowerCase()).toContain("language leverage");
    expect(f?.description.toLowerCase()).toContain("competitive positioning");
    expect(f?.inverse).toBe(false);
    expect(f?.defaultWeight).toBe(0.10);
    expect(f?.implemented).toBe(true);
  });

  it("7.1.7 risk — legal, political, economic, competitive (inverse)", () => {
    const f = PRIORITY_FACTORS.find((f) => f.factor === "risk");
    expect(f?.title).toBe("Risk");
    expect(f?.description.toLowerCase()).toContain("legal");
    expect(f?.description.toLowerCase()).toContain("political");
    expect(f?.description.toLowerCase()).toContain("economic");
    expect(f?.description.toLowerCase()).toContain("competitive");
    expect(f?.inverse).toBe(true); // high risk = low contribution.
    expect(f?.defaultWeight).toBe(0.10);
    expect(f?.implemented).toBe(true);
  });

  it("default weights sum to 1.0", () => {
    const sum = Object.values(DEFAULT_SCORE_WEIGHTS.weights).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 1.0)).toBeLessThan(0.001);
  });

  it("weights are versioned + configurable", () => {
    const v = verifyPrioritizationStage();
    expect(v.weightsVersioned).toBe(true);
    expect(v.weightsConfigurable).toBe(true);
  });

  it("queue + override functions are implemented", () => {
    const v = verifyPrioritizationStage();
    expect(v.queueFunctionImplemented).toBe(true);
    expect(v.overrideFunctionsImplemented).toBe(true);
  });

  it("inverse factors are cost_to_launch + risk", () => {
    const inverse = PRIORITY_FACTORS.filter((f) => f.inverse).map((f) => f.factor);
    expect(inverse).toContain("cost_to_launch");
    expect(inverse).toContain("risk");
    expect(inverse).toHaveLength(2);
  });

  it("PriorityFactor is the union of 7 named factors", () => {
    const f1: PriorityFactor = "demand";
    const f2: PriorityFactor = "market_size";
    const f3: PriorityFactor = "revenue_potential";
    const f4: PriorityFactor = "readiness";
    const f5: PriorityFactor = "cost_to_launch";
    const f6: PriorityFactor = "strategic_value";
    const f7: PriorityFactor = "risk";
    expect([f1, f2, f3, f4, f5, f6, f7]).toHaveLength(7);
  });

  it("OverrideAction is the union of 4 actions", () => {
    const a1: OverrideAction = "promote";
    const a2: OverrideAction = "demote";
    const a3: OverrideAction = "remove";
    const a4: OverrideAction = "add";
    expect([a1, a2, a3, a4]).toHaveLength(4);
  });

  it("ScoreWeights type has version + weights + effectiveFrom + active + updatedBy", () => {
    const w: ScoreWeights = {
      version: 1,
      weights: {
        demand: 0.20, market_size: 0.15, revenue_potential: 0.20, readiness: 0.15,
        cost_to_launch: 0.10, strategic_value: 0.10, risk: 0.10,
      },
      effectiveFrom: new Date(),
      active: true,
      updatedBy: "test",
    };
    expect(w.version).toBe(1);
    expect(w.active).toBe(true);
    expect(Object.keys(w.weights)).toHaveLength(7);
  });

  it("FactorScore type has factor + rawScore + contribution + weight + inverse + source", () => {
    const f: FactorScore = {
      factor: "demand",
      rawScore: 80,
      contribution: 16,
      weight: 0.20,
      inverse: false,
      source: "test",
    };
    expect(f.factor).toBe("demand");
    expect(f.contribution).toBe(f.rawScore * f.weight);
  });

  it("QueueEntry type has rank + totalScore + overrideApplied", () => {
    const q: QueueEntry = {
      regionCode: "us",
      rank: 1,
      totalScore: 85,
      factorBreakdown: [],
      overrideApplied: "none",
      queuedAt: new Date(),
    };
    expect(q.rank).toBe(1);
    expect(q.overrideApplied).toBe("none");
  });
});

// ───────────────────────────────────────────────
// 8. Stage 4 — Preparation (3 workstreams)
// ───────────────────────────────────────────────

describe("8 — Stage 4 Preparation (9 workstreams)", () => {
  it("has 9 workstreams implemented (8.1-8.9)", () => {
    expect(PREPARATION_WORKSTREAMS).toHaveLength(9);
    const ids = PREPARATION_WORKSTREAMS.map((w) => w.workstream);
    expect(ids).toContain("language");
    expect(ids).toContain("content");
    expect(ids).toContain("legal");
    expect(ids).toContain("tax");
    expect(ids).toContain("payments");
    expect(ids).toContain("infrastructure");
    expect(ids).toContain("support");
    expect(ids).toContain("marketing");
    expect(ids).toContain("cultural");
  });

  it("all 9 workstreams are implemented", () => {
    const v = verifyPreparationStage();
    expect(v.implementedWorkstreams).toBe(9);
    expect(v.totalWorkstreams).toBe(9);
    expect(v.allImplemented).toBe(true);
  });

  it("every workstream has at least 1 human checkpoint", () => {
    const v = verifyPreparationStage();
    expect(v.humanCheckpoints).toBeGreaterThanOrEqual(9); // 1 per workstream.
    for (const w of v.workstreams) {
      expect(w.humanCheckpointCount).toBeGreaterThanOrEqual(1);
    }
  });

  it("8.1 Language workstream — 8 steps + 1 human checkpoint", () => {
    const w = getWorkstream("language");
    expect(w?.number).toBe("8.1");
    expect(w?.title).toBe("Language Workstream");
    expect(w?.goal).toContain("i18n pipeline");
    expect(w?.steps).toHaveLength(9); // 8 autonomous + 1 HC.
    expect(w?.steps.filter((s) => s.mode === "autonomous")).toHaveLength(8);
    expect(w?.steps.filter((s) => s.mode === "human_checkpoint")).toHaveLength(1);
    expect(w?.implemented).toBe(true);
  });

  it("8.1.1 add language via i18n pipeline", () => {
    const step = LANGUAGE_WORKSTREAM.steps.find((s) => s.id === "8.1.1");
    expect(step?.title).toContain("i18n pipeline");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.1.2 translate all strings — AI + native review + QA", () => {
    const step = LANGUAGE_WORKSTREAM.steps.find((s) => s.id === "8.1.2");
    expect(step?.title).toContain("Translate all strings");
    expect(step?.description).toContain("AI");
    expect(step?.description).toContain("native-speaker review");
    expect(step?.description).toContain("automated QA");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.1.3 review UI copy for cultural fit", () => {
    const step = LANGUAGE_WORKSTREAM.steps.find((s) => s.id === "8.1.3");
    expect(step?.title).toContain("cultural fit");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.1.4 add language to chat, voice, tools, design, business, agents", () => {
    const step = LANGUAGE_WORKSTREAM.steps.find((s) => s.id === "8.1.4");
    expect(step?.title).toContain("chat");
    expect(step?.title).toContain("voice");
    expect(step?.title).toContain("tools");
    expect(step?.title).toContain("design");
    expect(step?.title).toContain("business");
    expect(step?.title).toContain("agents");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.1.5 verify RTL where applicable", () => {
    const step = LANGUAGE_WORKSTREAM.steps.find((s) => s.id === "8.1.5");
    expect(step?.title).toContain("RTL");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.1.6 add fonts for the script", () => {
    const step = LANGUAGE_WORKSTREAM.steps.find((s) => s.id === "8.1.6");
    expect(step?.title).toContain("fonts");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.1.7 test every flow in the language", () => {
    const step = LANGUAGE_WORKSTREAM.steps.find((s) => s.id === "8.1.7");
    expect(step?.title).toContain("Test every flow");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.1.8 publish locale landing page", () => {
    const step = LANGUAGE_WORKSTREAM.steps.find((s) => s.id === "8.1.8");
    expect(step?.title).toContain("locale landing page");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.1.HC human checkpoint: native-speaker review + sign-off", () => {
    const step = LANGUAGE_WORKSTREAM.steps.find((s) => s.id === "8.1.HC");
    expect(step?.title).toContain("native-speaker review");
    expect(step?.title).toContain("sign-off");
    expect(step?.mode).toBe("human_checkpoint");
    expect(step?.implemented).toBe(true);
  });

  it("8.2 Content workstream — 6 steps + 1 human checkpoint", () => {
    const w = getWorkstream("content");
    expect(w?.number).toBe("8.2");
    expect(w?.title).toBe("Content Workstream");
    expect(w?.goal).toContain("Translate");
    expect(w?.steps).toHaveLength(7); // 6 autonomous + 1 HC.
    expect(w?.steps.filter((s) => s.mode === "autonomous")).toHaveLength(6);
    expect(w?.steps.filter((s) => s.mode === "human_checkpoint")).toHaveLength(1);
    expect(w?.implemented).toBe(true);
  });

  it("8.2.1 translate help center, blog, changelog, status, legal, marketing", () => {
    const step = CONTENT_WORKSTREAM.steps.find((s) => s.id === "8.2.1");
    expect(step?.title).toContain("help center");
    expect(step?.title).toContain("blog");
    expect(step?.title).toContain("changelog");
    expect(step?.title).toContain("status page");
    expect(step?.title).toContain("legal");
    expect(step?.title).toContain("marketing");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.2.2 adapt content (examples, currency, imagery, date formats)", () => {
    const step = CONTENT_WORKSTREAM.steps.find((s) => s.id === "8.2.2");
    expect(step?.title).toContain("Adapt content");
    expect(step?.description).toContain("examples");
    expect(step?.description).toContain("currency");
    expect(step?.description).toContain("imagery");
    expect(step?.description).toContain("date formats");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.2.3 add region-specific help articles", () => {
    const step = CONTENT_WORKSTREAM.steps.find((s) => s.id === "8.2.3");
    expect(step?.title).toContain("region-specific help");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.2.4 publish region-specific blog posts + case studies", () => {
    const step = CONTENT_WORKSTREAM.steps.find((s) => s.id === "8.2.4");
    expect(step?.title).toContain("blog posts");
    expect(step?.title).toContain("case studies");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.2.5 update SEO metadata, OG images, structured data", () => {
    const step = CONTENT_WORKSTREAM.steps.find((s) => s.id === "8.2.5");
    expect(step?.title).toContain("SEO metadata");
    expect(step?.title).toContain("OG images");
    expect(step?.title).toContain("structured data");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.2.6 verify content accuracy with native speaker", () => {
    const step = CONTENT_WORKSTREAM.steps.find((s) => s.id === "8.2.6");
    expect(step?.title).toContain("content accuracy");
    expect(step?.title).toContain("native speaker");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.2.HC human checkpoint: editorial review before public launch", () => {
    const step = CONTENT_WORKSTREAM.steps.find((s) => s.id === "8.2.HC");
    expect(step?.title).toContain("editorial review");
    expect(step?.title).toContain("public launch");
    expect(step?.mode).toBe("human_checkpoint");
    expect(step?.implemented).toBe(true);
  });

  it("8.3 Legal workstream — 6 steps + 1 human checkpoint", () => {
    const w = getWorkstream("legal");
    expect(w?.number).toBe("8.3");
    expect(w?.title).toBe("Legal Workstream");
    expect(w?.goal).toContain("Identify applicable laws");
    expect(w?.steps).toHaveLength(7); // 6 autonomous + 1 HC.
    expect(w?.steps.filter((s) => s.mode === "autonomous")).toHaveLength(6);
    expect(w?.steps.filter((s) => s.mode === "human_checkpoint")).toHaveLength(1);
    expect(w?.implemented).toBe(true);
  });

  it("8.3.1 identify applicable laws (privacy, consumer, data residency, content, tax)", () => {
    const step = LEGAL_WORKSTREAM.steps.find((s) => s.id === "8.3.1");
    expect(step?.title).toContain("privacy");
    expect(step?.title).toContain("consumer protection");
    expect(step?.title).toContain("data residency");
    expect(step?.title).toContain("content");
    expect(step?.title).toContain("tax");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.3.2 draft Privacy Policy, ToS, Cookie Policy, DPA, Refund Policy", () => {
    const step = LEGAL_WORKSTREAM.steps.find((s) => s.id === "8.3.2");
    expect(step?.title).toContain("Privacy Policy");
    expect(step?.title).toContain("Terms of Service");
    expect(step?.title).toContain("Cookie Policy");
    expect(step?.title).toContain("DPA");
    expect(step?.title).toContain("Refund Policy");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.3.3 review with local counsel where required", () => {
    const step = LEGAL_WORKSTREAM.steps.find((s) => s.id === "8.3.3");
    expect(step?.title).toContain("local counsel");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.3.4 publish legal documents per region", () => {
    const step = LEGAL_WORKSTREAM.steps.find((s) => s.id === "8.3.4");
    expect(step?.title).toContain("Publish legal documents");
    expect(step?.title).toContain("per region");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.3.5 configure cookie consent per jurisdiction", () => {
    const step = LEGAL_WORKSTREAM.steps.find((s) => s.id === "8.3.5");
    expect(step?.title).toContain("cookie consent");
    expect(step?.title).toContain("jurisdiction");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.3.6 document compliance evidence", () => {
    const step = LEGAL_WORKSTREAM.steps.find((s) => s.id === "8.3.6");
    expect(step?.title).toContain("compliance evidence");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.3.HC human checkpoint: legal review + sign-off before public launch", () => {
    const step = LEGAL_WORKSTREAM.steps.find((s) => s.id === "8.3.HC");
    expect(step?.title).toContain("legal review");
    expect(step?.title).toContain("sign-off");
    expect(step?.title).toContain("public launch");
    expect(step?.mode).toBe("human_checkpoint");
    expect(step?.implemented).toBe(true);
  });

  it("WorkstreamId is the union of 9 named workstreams", () => {
    const w1: WorkstreamId = "language";
    const w2: WorkstreamId = "content";
    const w3: WorkstreamId = "legal";
    const w4: WorkstreamId = "tax";
    const w5: WorkstreamId = "payments";
    const w6: WorkstreamId = "infrastructure";
    const w7: WorkstreamId = "support";
    const w8: WorkstreamId = "marketing";
    const w9: WorkstreamId = "cultural";
    expect([w1, w2, w3, w4, w5, w6, w7, w8, w9]).toHaveLength(9);
  });

  it("StepMode is the union of autonomous + human_checkpoint", () => {
    const m1: StepMode = "autonomous";
    const m2: StepMode = "human_checkpoint";
    expect([m1, m2]).toHaveLength(2);
  });

  it("StepResult type has stepId + title + status + mode + detail + completedAt", () => {
    const s: StepResult = {
      stepId: "8.1.1",
      title: "test",
      status: "completed",
      mode: "autonomous",
      detail: "done",
      completedAt: new Date(),
    };
    expect(s.stepId).toBe("8.1.1");
    expect(s.status).toBe("completed");
  });

  it("WorkstreamResult type has workstream + regionCode + steps + ready + pendingCheckpoints", () => {
    const r: WorkstreamResult = {
      workstream: "language",
      regionCode: "us",
      steps: [],
      ready: true,
      pendingCheckpoints: [],
      startedAt: new Date(),
      completedAt: new Date(),
    };
    expect(r.workstream).toBe("language");
    expect(r.ready).toBe(true);
  });
});

// ───────────────────────────────────────────────
// 8.4 Tax Workstream — 5 steps + 1 human checkpoint
// ───────────────────────────────────────────────

describe("8.4 — Tax Workstream", () => {
  it("has 5 autonomous steps + 1 human checkpoint", () => {
    const w = getWorkstream("tax");
    expect(w?.number).toBe("8.4");
    expect(w?.title).toBe("Tax Workstream");
    expect(w?.goal).toContain("taxes");
    expect(w?.steps).toHaveLength(6); // 5 + 1 HC.
    expect(w?.steps.filter((s) => s.mode === "autonomous")).toHaveLength(5);
    expect(w?.steps.filter((s) => s.mode === "human_checkpoint")).toHaveLength(1);
    expect(w?.implemented).toBe(true);
  });

  it("8.4.1 determine applicable taxes (VAT, GST, sales tax, DST)", () => {
    const step = TAX_WORKSTREAM.steps.find((s) => s.id === "8.4.1");
    expect(step?.title).toContain("applicable taxes");
    expect(step?.description).toContain("VAT");
    expect(step?.description).toContain("GST");
    expect(step?.description).toContain("sales tax");
    expect(step?.description).toContain("digital services tax");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.4.2 register where required", () => {
    const step = TAX_WORKSTREAM.steps.find((s) => s.id === "8.4.2");
    expect(step?.title).toContain("Register");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.4.3 configure tax rules in the billing system", () => {
    const step = TAX_WORKSTREAM.steps.find((s) => s.id === "8.4.3");
    expect(step?.title).toContain("tax rules");
    expect(step?.title).toContain("billing system");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.4.4 configure invoices to reflect local requirements", () => {
    const step = TAX_WORKSTREAM.steps.find((s) => s.id === "8.4.4");
    expect(step?.title).toContain("invoices");
    expect(step?.title).toContain("local requirements");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.4.5 configure reporting to tax authorities where required", () => {
    const step = TAX_WORKSTREAM.steps.find((s) => s.id === "8.4.5");
    expect(step?.title).toContain("reporting");
    expect(step?.title).toContain("tax authorities");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.4.HC human checkpoint: tax review + sign-off before public launch", () => {
    const step = TAX_WORKSTREAM.steps.find((s) => s.id === "8.4.HC");
    expect(step?.title).toContain("tax review");
    expect(step?.title).toContain("sign-off");
    expect(step?.mode).toBe("human_checkpoint");
    expect(step?.implemented).toBe(true);
  });
});

// ───────────────────────────────────────────────
// 8.5 Payments Workstream — 6 steps + 1 human checkpoint
// ───────────────────────────────────────────────

describe("8.5 — Payments Workstream", () => {
  it("has 6 autonomous steps + 1 human checkpoint", () => {
    const w = getWorkstream("payments");
    expect(w?.number).toBe("8.5");
    expect(w?.title).toBe("Payments Workstream");
    expect(w?.goal).toContain("payment methods");
    expect(w?.steps).toHaveLength(7); // 6 + 1 HC.
    expect(w?.steps.filter((s) => s.mode === "autonomous")).toHaveLength(6);
    expect(w?.steps.filter((s) => s.mode === "human_checkpoint")).toHaveLength(1);
    expect(w?.implemented).toBe(true);
  });

  it("8.5.1 enable local payment methods (Stripe/Paystack/Flutterwave)", () => {
    const step = PAYMENTS_WORKSTREAM.steps.find((s) => s.id === "8.5.1");
    expect(step?.title).toContain("local payment methods");
    expect(step?.title).toContain("Stripe");
    expect(step?.title).toContain("Paystack");
    expect(step?.title).toContain("Flutterwave");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.5.2 enable local currencies", () => {
    const step = PAYMENTS_WORKSTREAM.steps.find((s) => s.id === "8.5.2");
    expect(step?.title).toContain("local currencies");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.5.3 configure pricing in local currency (PPP where appropriate)", () => {
    const step = PAYMENTS_WORKSTREAM.steps.find((s) => s.id === "8.5.3");
    expect(step?.title).toContain("pricing");
    expect(step?.title).toContain("local currency");
    expect(step?.description).toContain("purchasing power parity");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.5.4 configure payouts for creators and partners", () => {
    const step = PAYMENTS_WORKSTREAM.steps.find((s) => s.id === "8.5.4");
    expect(step?.title).toContain("payouts");
    expect(step?.title).toContain("creators");
    expect(step?.title).toContain("partners");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.5.5 test end-to-end payment flows in sandbox", () => {
    const step = PAYMENTS_WORKSTREAM.steps.find((s) => s.id === "8.5.5");
    expect(step?.title).toContain("end-to-end payment flows");
    expect(step?.title).toContain("sandbox");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.5.6 verify refunds, disputes, and chargebacks work", () => {
    const step = PAYMENTS_WORKSTREAM.steps.find((s) => s.id === "8.5.6");
    expect(step?.title).toContain("refunds");
    expect(step?.title).toContain("disputes");
    expect(step?.title).toContain("chargebacks");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.5.HC human checkpoint: payments review + sign-off before public launch", () => {
    const step = PAYMENTS_WORKSTREAM.steps.find((s) => s.id === "8.5.HC");
    expect(step?.title).toContain("payments review");
    expect(step?.title).toContain("sign-off");
    expect(step?.mode).toBe("human_checkpoint");
    expect(step?.implemented).toBe(true);
  });
});

// ───────────────────────────────────────────────
// 8.6 Infrastructure Workstream — 6 steps + 1 human checkpoint
// ───────────────────────────────────────────────

describe("8.6 — Infrastructure Workstream", () => {
  it("has 6 autonomous steps + 1 human checkpoint", () => {
    const w = getWorkstream("infrastructure");
    expect(w?.number).toBe("8.6");
    expect(w?.title).toBe("Infrastructure Workstream");
    expect(w?.goal).toContain("regional infrastructure");
    expect(w?.steps).toHaveLength(7); // 6 + 1 HC.
    expect(w?.steps.filter((s) => s.mode === "autonomous")).toHaveLength(6);
    expect(w?.steps.filter((s) => s.mode === "human_checkpoint")).toHaveLength(1);
    expect(w?.implemented).toBe(true);
  });

  it("8.6.1 determine data residency requirements", () => {
    const step = INFRASTRUCTURE_WORKSTREAM.steps.find((s) => s.id === "8.6.1");
    expect(step?.title).toContain("data residency");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.6.2 provision regional infrastructure (EU/US/APAC/Africa/LATAM)", () => {
    const step = INFRASTRUCTURE_WORKSTREAM.steps.find((s) => s.id === "8.6.2");
    expect(step?.title).toContain("Provision regional infrastructure");
    expect(step?.title).toContain("EU");
    expect(step?.title).toContain("US");
    expect(step?.title).toContain("APAC");
    expect(step?.title).toContain("Africa");
    expect(step?.title).toContain("LATAM");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.6.3 configure CDN coverage", () => {
    const step = INFRASTRUCTURE_WORKSTREAM.steps.find((s) => s.id === "8.6.3");
    expect(step?.title).toContain("CDN coverage");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.6.4 configure latency routing", () => {
    const step = INFRASTRUCTURE_WORKSTREAM.steps.find((s) => s.id === "8.6.4");
    expect(step?.title).toContain("latency routing");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.6.5 configure backups and disaster recovery in-region", () => {
    const step = INFRASTRUCTURE_WORKSTREAM.steps.find((s) => s.id === "8.6.5");
    expect(step?.title).toContain("backups");
    expect(step?.title).toContain("disaster recovery");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.6.6 test failover", () => {
    const step = INFRASTRUCTURE_WORKSTREAM.steps.find((s) => s.id === "8.6.6");
    expect(step?.title).toContain("Test failover");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.6.HC human checkpoint: infrastructure review before public launch", () => {
    const step = INFRASTRUCTURE_WORKSTREAM.steps.find((s) => s.id === "8.6.HC");
    expect(step?.title).toContain("infrastructure review");
    expect(step?.mode).toBe("human_checkpoint");
    expect(step?.implemented).toBe(true);
  });
});

// ───────────────────────────────────────────────
// 8.7 Support Workstream — 6 steps + 1 human checkpoint
// ───────────────────────────────────────────────

describe("8.7 — Support Workstream", () => {
  it("has 6 autonomous steps + 1 human checkpoint", () => {
    const w = getWorkstream("support");
    expect(w?.number).toBe("8.7");
    expect(w?.title).toBe("Support Workstream");
    expect(w?.goal).toContain("support");
    expect(w?.steps).toHaveLength(7); // 6 + 1 HC.
    expect(w?.steps.filter((s) => s.mode === "autonomous")).toHaveLength(6);
    expect(w?.steps.filter((s) => s.mode === "human_checkpoint")).toHaveLength(1);
    expect(w?.implemented).toBe(true);
  });

  it("8.7.1 enable support in the region's language", () => {
    const step = SUPPORT_WORKSTREAM.steps.find((s) => s.id === "8.7.1");
    expect(step?.title).toContain("support");
    expect(step?.title).toContain("language");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.7.2 set support hours appropriate to the region", () => {
    const step = SUPPORT_WORKSTREAM.steps.find((s) => s.id === "8.7.2");
    expect(step?.title).toContain("support hours");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.7.3 train support agents on the region", () => {
    const step = SUPPORT_WORKSTREAM.steps.find((s) => s.id === "8.7.3");
    expect(step?.title).toContain("Train support agents");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.7.4 configure SLAs and escalation", () => {
    const step = SUPPORT_WORKSTREAM.steps.find((s) => s.id === "8.7.4");
    expect(step?.title).toContain("SLAs");
    expect(step?.title).toContain("escalation");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.7.5 localize macros and templates", () => {
    const step = SUPPORT_WORKSTREAM.steps.find((s) => s.id === "8.7.5");
    expect(step?.title).toContain("macros");
    expect(step?.title).toContain("templates");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.7.6 configure the AI triage model for the language", () => {
    const step = SUPPORT_WORKSTREAM.steps.find((s) => s.id === "8.7.6");
    expect(step?.title).toContain("AI triage model");
    expect(step?.title).toContain("language");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.7.HC human checkpoint: support readiness sign-off", () => {
    const step = SUPPORT_WORKSTREAM.steps.find((s) => s.id === "8.7.HC");
    expect(step?.title).toContain("support readiness sign-off");
    expect(step?.mode).toBe("human_checkpoint");
    expect(step?.implemented).toBe(true);
  });
});

// ───────────────────────────────────────────────
// 8.8 Marketing Workstream — 7 steps + 1 human checkpoint
// ───────────────────────────────────────────────

describe("8.8 — Marketing Workstream", () => {
  it("has 7 autonomous steps + 1 human checkpoint", () => {
    const w = getWorkstream("marketing");
    expect(w?.number).toBe("8.8");
    expect(w?.title).toBe("Marketing Workstream");
    expect(w?.goal).toContain("marketing assets");
    expect(w?.steps).toHaveLength(8); // 7 + 1 HC.
    expect(w?.steps.filter((s) => s.mode === "autonomous")).toHaveLength(7);
    expect(w?.steps.filter((s) => s.mode === "human_checkpoint")).toHaveLength(1);
    expect(w?.implemented).toBe(true);
  });

  it("8.8.1 prepare region-specific landing pages", () => {
    const step = MARKETING_WORKSTREAM.steps.find((s) => s.id === "8.8.1");
    expect(step?.title).toContain("landing pages");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.8.2 prepare region-specific ads and creatives", () => {
    const step = MARKETING_WORKSTREAM.steps.find((s) => s.id === "8.8.2");
    expect(step?.title).toContain("ads");
    expect(step?.title).toContain("creatives");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.8.3 prepare region-specific emails and sequences", () => {
    const step = MARKETING_WORKSTREAM.steps.find((s) => s.id === "8.8.3");
    expect(step?.title).toContain("emails");
    expect(step?.title).toContain("sequences");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.8.4 prepare region-specific social content", () => {
    const step = MARKETING_WORKSTREAM.steps.find((s) => s.id === "8.8.4");
    expect(step?.title).toContain("social content");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.8.5 prepare partnerships and influencer outreach", () => {
    const step = MARKETING_WORKSTREAM.steps.find((s) => s.id === "8.8.5");
    expect(step?.title).toContain("partnerships");
    expect(step?.title).toContain("influencer");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.8.6 prepare press materials in the language", () => {
    const step = MARKETING_WORKSTREAM.steps.find((s) => s.id === "8.8.6");
    expect(step?.title).toContain("press materials");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.8.7 schedule launch campaign", () => {
    const step = MARKETING_WORKSTREAM.steps.find((s) => s.id === "8.8.7");
    expect(step?.title).toContain("Schedule launch campaign");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.8.HC human checkpoint: marketing review before public launch", () => {
    const step = MARKETING_WORKSTREAM.steps.find((s) => s.id === "8.8.HC");
    expect(step?.title).toContain("marketing review");
    expect(step?.mode).toBe("human_checkpoint");
    expect(step?.implemented).toBe(true);
  });
});

// ───────────────────────────────────────────────
// 8.9 Cultural Workstream — 6 steps + 1 human checkpoint
// ───────────────────────────────────────────────

describe("8.9 — Cultural Workstream", () => {
  it("has 6 autonomous steps + 1 human checkpoint", () => {
    const w = getWorkstream("cultural");
    expect(w?.number).toBe("8.9");
    expect(w?.title).toBe("Cultural Workstream");
    expect(w?.goal).toContain("cultural norms");
    expect(w?.steps).toHaveLength(7); // 6 + 1 HC.
    expect(w?.steps.filter((s) => s.mode === "autonomous")).toHaveLength(6);
    expect(w?.steps.filter((s) => s.mode === "human_checkpoint")).toHaveLength(1);
    expect(w?.implemented).toBe(true);
  });

  it("8.9.1 review imagery, colors, and naming conventions", () => {
    const step = CULTURAL_WORKSTREAM.steps.find((s) => s.id === "8.9.1");
    expect(step?.title).toContain("imagery");
    expect(step?.title).toContain("colors");
    expect(step?.title).toContain("naming conventions");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.9.2 adapt examples and use cases", () => {
    const step = CULTURAL_WORKSTREAM.steps.find((s) => s.id === "8.9.2");
    expect(step?.title).toContain("examples");
    expect(step?.title).toContain("use cases");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.9.3 adapt tone and formality", () => {
    const step = CULTURAL_WORKSTREAM.steps.find((s) => s.id === "8.9.3");
    expect(step?.title).toContain("tone");
    expect(step?.title).toContain("formality");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.9.4 verify date, number, address, and name formats", () => {
    const step = CULTURAL_WORKSTREAM.steps.find((s) => s.id === "8.9.4");
    expect(step?.title).toContain("date");
    expect(step?.title).toContain("number");
    expect(step?.title).toContain("address");
    expect(step?.title).toContain("name formats");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.9.5 verify RTL layout where applicable", () => {
    const step = CULTURAL_WORKSTREAM.steps.find((s) => s.id === "8.9.5");
    expect(step?.title).toContain("RTL layout");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.9.6 verify sensitivity to cultural norms", () => {
    const step = CULTURAL_WORKSTREAM.steps.find((s) => s.id === "8.9.6");
    expect(step?.title).toContain("sensitivity");
    expect(step?.title).toContain("cultural norms");
    expect(step?.mode).toBe("autonomous");
    expect(step?.implemented).toBe(true);
  });

  it("8.9.HC human checkpoint: cultural review + sign-off before public launch", () => {
    const step = CULTURAL_WORKSTREAM.steps.find((s) => s.id === "8.9.HC");
    expect(step?.title).toContain("cultural review");
    expect(step?.title).toContain("sign-off");
    expect(step?.mode).toBe("human_checkpoint");
    expect(step?.implemented).toBe(true);
  });
});
