/**
 * Reports tests — the spine pays rent.
 *
 * Covers:
 *   - Engine: runReport with metrics + dimensions + provenance
 *   - FX honesty: as-of semantics, reproducibility, zero-division
 *   - Reports catalog: revenue, P&L, cash flow, receivables aging, tax
 *   - Dashboard: batched query, rollup verification, cache staleness
 *   - AI summary: fact-grounding verification (hallucinated numbers caught)
 *   - Provenance: every figure traces to facts whose sum equals the figure
 *   - Empty states: honest empty, never NaN, never blank
 */

import { describe, it, expect } from "vitest";
import { runReport, traceProvenance, type ReportFact } from "../src/engine.js";
import { computeDelta, convertAtRecordedRate, assertReproducible } from "../src/money.js";
import { revenueReport, pnlReport, cashFlowReport, receivablesAgingReport, comparisonReport } from "../src/reports/catalog.js";
import { buildDashboard, buildDailyRollup, verifyRollup, cacheDashboard } from "../src/dashboard.js";
import { buildAiSummary, verifyFactGrounding, extractNumbers, type AiSummaryInput } from "../src/ai-summary.js";
import { asCurrency } from "@supa/money/money";
import type { WorkspaceId } from "@supa/workspace-core/workspace";

const WS = "00000000-0000-0000-0000-000000000001" as WorkspaceId;
const NGN = asCurrency("NGN");
const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function makeFact(overrides: Partial<ReportFact> & { id: string }): ReportFact {
  return {
    wsId: WS,
    nativeAmountMinor: 100_000n,
    nativeCurrency: "NGN",
    recordedRate: null,
    asOf: NOW,
    kind: "invoice-issued",
    sourceId: "inv-1",
    ...overrides,
  };
}

// ─── Engine ───

describe("runReport — engine primitives", () => {
  it("revenue metric filters to invoice-issued + invoice-paid", () => {
    const facts = [
      makeFact({ id: "f1", kind: "invoice-issued", nativeAmountMinor: 500_000n }),
      makeFact({ id: "f2", kind: "invoice-paid", nativeAmountMinor: 300_000n }),
      makeFact({ id: "f3", kind: "expense-recorded", nativeAmountMinor: 100_000n }),
    ];
    const result = runReport(facts, {
      metric: "revenue", dimensions: ["none"], filters: {},
      period: { from: 0, to: NOW + 1 }, baseCurrency: NGN,
    });
    expect(result.totals.factCount).toBe(2); // invoice-issued + invoice-paid (not expense)
  });

  it("groups by month", () => {
    const facts = [
      makeFact({ id: "f1", kind: "invoice-issued", nativeAmountMinor: 500_000n, asOf: NOW - 10 * DAY }),
      makeFact({ id: "f2", kind: "invoice-issued", nativeAmountMinor: 300_000n, asOf: NOW - 40 * DAY }),
    ];
    const result = runReport(facts, {
      metric: "revenue", dimensions: ["by-month"], filters: {},
      period: { from: 0, to: NOW + 1 }, baseCurrency: NGN,
    });
    expect(result.rows.length).toBe(2); // two different months
  });

  it("provenance: every row carries its facts", () => {
    const facts = [
      makeFact({ id: "f1", kind: "invoice-issued", nativeAmountMinor: 500_000n }),
      makeFact({ id: "f2", kind: "invoice-issued", nativeAmountMinor: 300_000n }),
    ];
    const result = runReport(facts, {
      metric: "revenue", dimensions: ["none"], filters: {},
      period: { from: 0, to: NOW + 1 }, baseCurrency: NGN,
    });
    expect(result.rows[0]?.facts.length).toBe(2);
    expect(result.rows[0]?.conversions.length).toBe(2);
  });

  it("traceProvenance: sum of facts equals the row amount", () => {
    const facts = [
      makeFact({ id: "f1", kind: "invoice-issued", nativeAmountMinor: 500_000n }),
      makeFact({ id: "f2", kind: "invoice-issued", nativeAmountMinor: 300_000n }),
    ];
    const result = runReport(facts, {
      metric: "revenue", dimensions: ["none"], filters: {},
      period: { from: 0, to: NOW + 1 }, baseCurrency: NGN,
    });
    const firstRow = result.rows[0];
    expect(firstRow).toBeDefined();
    if (!firstRow) throw new Error("expected report row");
    const trace = traceProvenance(firstRow);
    expect(trace.consistent).toBe(true);
    expect(trace.nativeSum.minor).toBe(800_000n);
  });
});

// ─── FX honesty ───

describe("FX honesty — as-of semantics", () => {
  it("computeDelta: from-zero growth shows +X, never ∞%", () => {
    const delta = computeDelta(
      { minor: 100_000n, currency: NGN },
      { minor: 0n, currency: NGN },
    );
    expect(delta.percentage).toBeNull();
    expect(delta.display).toContain("+");
  });

  it("computeDelta: normal percentage", () => {
    const delta = computeDelta(
      { minor: 120_000n, currency: NGN },
      { minor: 100_000n, currency: NGN },
    );
    expect(delta.percentage).toBe(20);
  });

  it("computeDelta: sign flip shows N/A", () => {
    const delta = computeDelta(
      { minor: 100_000n, currency: NGN },
      { minor: -50_000n, currency: NGN },
    );
    expect(delta.percentage).toBeNull();
    expect(delta.display).toBe("N/A");
  });

  it("assertReproducible: facts with rates are reproducible", () => {
    const facts = [
      { nativeAmountMinor: 100n, nativeCurrency: "USD", recordedRate: { from: asCurrency("USD"), to: NGN, rate: "1500", asOf: NOW, source: "provider" as const }, asOf: NOW },
    ];
    const result = assertReproducible(facts, NGN);
    expect(result.reproducible).toBe(true);
  });

  it("assertReproducible: facts without rates are NOT reproducible", () => {
    const facts = [
      { nativeAmountMinor: 100n, nativeCurrency: "USD", recordedRate: null, asOf: NOW },
    ];
    const result = assertReproducible(facts, NGN);
    expect(result.reproducible).toBe(false);
  });

  it("convertAtRecordedRate: same currency = no conversion", () => {
    const result = convertAtRecordedRate(
      { minor: 100_000n, currency: NGN },
      NGN,
      null,
    );
    expect(result.converted).toBe(true);
    expect(result.base.minor).toBe(100_000n);
    expect(result.rate).toBeNull();
  });

  it("convertAtRecordedRate: no rate = honest gap (base=zero)", () => {
    const result = convertAtRecordedRate(
      { minor: 100_000n, currency: asCurrency("USD") },
      NGN,
      null,
    );
    expect(result.converted).toBe(false);
    expect(result.base.minor).toBe(0n);
  });
});

// ─── Reports catalog ───

describe("Revenue report — invoiced vs collected", () => {
  it("the gap IS the story (outstanding = invoiced − collected)", () => {
    const facts = [
      makeFact({ id: "f1", kind: "invoice-issued", nativeAmountMinor: 500_000n, asOf: NOW - 10 * DAY }),
      makeFact({ id: "f2", kind: "invoice-paid", nativeAmountMinor: 300_000n, asOf: NOW - 5 * DAY }),
    ];
    const report = revenueReport(facts, { from: 0, to: NOW + 1 }, NGN);
    expect(report.outstanding.base).toBe(200_000n); // 500k − 300k
  });
});

describe("P&L — revenue − expenses with margin", () => {
  it("computes net profit + margin", () => {
    const facts = [
      makeFact({ id: "f1", kind: "invoice-issued", nativeAmountMinor: 1_000_000n }),
      makeFact({ id: "f2", kind: "expense-recorded", nativeAmountMinor: 400_000n }),
    ];
    const report = pnlReport(facts, { from: 0, to: NOW + 1 }, NGN);
    expect(report.netProfit.base).toBe(600_000n);
    expect(report.margin).toBe(60); // 600k / 1000k = 60%
  });

  it("zero revenue → margin null (zero-division honesty)", () => {
    const facts = [
      makeFact({ id: "f1", kind: "expense-recorded", nativeAmountMinor: 400_000n }),
    ];
    const report = pnlReport(facts, { from: 0, to: NOW + 1 }, NGN);
    expect(report.margin).toBeNull();
  });
});

describe("Cash flow — IN minus OUT", () => {
  it("computes net cash", () => {
    const facts = [
      makeFact({ id: "f1", kind: "payment", nativeAmountMinor: 500_000n }),
      makeFact({ id: "f2", kind: "expense-recorded", nativeAmountMinor: 200_000n }),
    ];
    const report = cashFlowReport(facts, { from: 0, to: NOW + 1 }, NGN);
    expect(report.netCash.base).toBe(300_000n); // 500k IN − 200k OUT
  });
});

describe("Receivables aging — buckets", () => {
  it("current + 30/60/90+ buckets", () => {
    const facts = [
      makeFact({ id: "f1", kind: "invoice-issued", nativeAmountMinor: 100_000n, asOf: NOW - 5 * DAY, sourceId: "inv-young" }),
      makeFact({ id: "f2", kind: "invoice-issued", nativeAmountMinor: 200_000n, asOf: NOW - 45 * DAY, sourceId: "inv-45d" }),
      makeFact({ id: "f3", kind: "invoice-issued", nativeAmountMinor: 300_000n, asOf: NOW - 75 * DAY, sourceId: "inv-75d" }),
      makeFact({ id: "f4", kind: "invoice-issued", nativeAmountMinor: 400_000n, asOf: NOW - 100 * DAY, sourceId: "inv-100d" }),
    ];
    const report = receivablesAgingReport(facts, NOW, NGN);
    expect(report.buckets.current.amount).toBe(100_000n); // 5 days → current (0-30)
    expect(report.buckets.days30.amount).toBe(200_000n); // 45 days → 31-60
    expect(report.buckets.days60.amount).toBe(300_000n); // 75 days → 61-90
    expect(report.buckets.days90plus.amount).toBe(400_000n); // 100 days → 91+
  });
});

describe("Comparison — period vs prior", () => {
  it("computes delta with display", () => {
    const facts = [
      makeFact({ id: "f1", kind: "invoice-issued", nativeAmountMinor: 120_000n, asOf: NOW }),
      makeFact({ id: "f2", kind: "invoice-issued", nativeAmountMinor: 100_000n, asOf: NOW - 30 * DAY }),
    ];
    const report = comparisonReport(
      facts,
      { from: NOW - 1, to: NOW + 1 },
      { from: NOW - 31 * DAY, to: NOW - 29 * DAY },
      NGN,
    );
    expect(report.current.totals.baseTotal.minor).toBe(120_000n);
    expect(report.prior.totals.baseTotal.minor).toBe(100_000n);
    expect(report.delta.percentage).toBe(20);
  });
});

// ─── Dashboard ───

describe("Dashboard — 3-second contract", () => {
  it("builds hero numbers in a single pass", () => {
    const facts = [
      makeFact({ id: "f1", kind: "invoice-issued", nativeAmountMinor: 1_000_000n }),
      makeFact({ id: "f2", kind: "expense-recorded", nativeAmountMinor: 400_000n }),
      makeFact({ id: "f3", kind: "invoice-paid", nativeAmountMinor: 600_000n }),
    ];
    const dash = buildDashboard(facts, { from: 0, to: NOW + 1 }, NGN, NOW);
    expect(dash.hero.revenue.minor).toBe(1_000_000n);
    expect(dash.hero.expenses.minor).toBe(400_000n);
    expect(dash.hero.netProfit.minor).toBe(600_000n);
    expect(dash.hero.receivables.minor).toBe(400_000n); // 1M issued − 600k paid
  });

  it("daily rollup is verifiable against facts", () => {
    const facts = [
      makeFact({ id: "f1", kind: "invoice-issued", nativeAmountMinor: 500_000n, asOf: NOW }),
    ];
    const rollup = buildDailyRollup(facts, NOW, NGN, WS);
    expect(rollup).not.toBeNull();
    if (!rollup) throw new Error("expected daily rollup");
    const verification = verifyRollup(rollup, facts);
    expect(verification.consistent).toBe(true);
  });

  it("rollup detects drift (self-healing cache)", () => {
    const facts = [
      makeFact({ id: "f1", kind: "invoice-issued", nativeAmountMinor: 500_000n, asOf: NOW }),
    ];
    const rollup = buildDailyRollup(facts, NOW, NGN, WS);
    if (!rollup) throw new Error("expected daily rollup");
    // Tamper with the rollup.
    const tampered = { ...rollup, revenueMinor: 999_999n };
    const verification = verifyRollup(tampered, facts);
    expect(verification.consistent).toBe(false);
  });

  it("cacheDashboard marks staleness visibly", () => {
    const facts: ReportFact[] = [];
    const dash = buildDashboard(facts, { from: 0, to: NOW + 1 }, NGN, NOW);
    const cached = cacheDashboard(dash, NOW + 60_000);
    expect(cached.data.fromCache).toBe(true);
    expect(cached.stalenessLabel).toContain("as of");
  });
});

// ─── AI summary — fact grounding ───

describe("AI summary — numbers extracted by code, not generated", () => {
  function makeInput(): AiSummaryInput {
    return {
      period: { from: NOW - 30 * DAY, to: NOW },
      baseCurrency: NGN,
      currentFacts: [
        makeFact({ id: "c1", kind: "invoice-issued", nativeAmountMinor: 412_000n, asOf: NOW - 10 * DAY }),
        makeFact({ id: "c2", kind: "expense-recorded", nativeAmountMinor: 150_000n, asOf: NOW - 5 * DAY }),
        makeFact({ id: "c3", kind: "invoice-paid", nativeAmountMinor: 300_000n, asOf: NOW - 3 * DAY }),
      ],
      priorFacts: [
        makeFact({ id: "p1", kind: "invoice-issued", nativeAmountMinor: 350_000n, asOf: NOW - 40 * DAY }),
        makeFact({ id: "p2", kind: "expense-recorded", nativeAmountMinor: 120_000n, asOf: NOW - 45 * DAY }),
      ],
    };
  }

  it("extractNumbers computes from facts (code, not model)", () => {
    const nums = extractNumbers(makeInput());
    expect(nums.revenue.current).toBe(412_000n);
    expect(nums.revenue.prior).toBe(350_000n);
    expect(nums.expenses.current).toBe(150_000n);
  });

  it("buildAiSummary: every line references numbers from ExtractedNumbers", () => {
    const summary = buildAiSummary(makeInput());
    expect(summary.lines.length).toBe(5);
    for (const line of summary.lines) {
      expect(line.referencedNumbers.length).toBeGreaterThan(0);
    }
  });

  it("verifyFactGrounding: all numbers in output match extracted values", () => {
    const summary = buildAiSummary(makeInput());
    const verification = verifyFactGrounding(summary);
    expect(verification.grounded).toBe(true);
    expect(verification.violations).toEqual([]);
  });

  it("verifyFactGrounding catches hallucinated numbers", () => {
    const summary = buildAiSummary(makeInput());
    // Inject a hallucinated number into a line.
    const tampered: typeof summary = {
      ...summary,
      lines: [
        ...summary.lines,
        {
          text: "Hidden revenue: 999999",
          referencedNumbers: [],
          reportLink: null,
        },
      ],
    };
    const verification = verifyFactGrounding(tampered);
    expect(verification.grounded).toBe(false);
    expect(verification.violations.length).toBeGreaterThan(0);
  });
});

// ─── Empty states ───

describe("Empty states — honest, never NaN, never blank", () => {
  it("empty workspace → all reports render zero, not NaN", () => {
    const facts: ReportFact[] = [];
    const dash = buildDashboard(facts, { from: 0, to: NOW + 1 }, NGN);
    expect(dash.hero.revenue.minor).toBe(0n);
    expect(dash.hero.expenses.minor).toBe(0n);
    expect(dash.hero.netProfit.minor).toBe(0n);
    expect(dash.hero.receivables.minor).toBe(0n);
  });

  it("workspace with only expenses → P&L shows negative profit, not NaN", () => {
    const facts = [
      makeFact({ id: "f1", kind: "expense-recorded", nativeAmountMinor: 100_000n }),
    ];
    const report = pnlReport(facts, { from: 0, to: NOW + 1 }, NGN);
    expect(report.netProfit.base).toBe(-100_000n);
    expect(report.margin).toBeNull(); // zero revenue → null margin
  });

  it("single-customer workspace → receivables aging renders correctly", () => {
    const facts = [
      makeFact({ id: "f1", kind: "invoice-issued", nativeAmountMinor: 200_000n, asOf: NOW - 10 * DAY, sourceId: "inv-1" }),
    ];
    const report = receivablesAgingReport(facts, NOW, NGN);
    expect(report.buckets.current.amount).toBe(200_000n); // 10 days → current (0-30)
    expect(report.buckets.days30.amount).toBe(0n); // nothing in 31-60
  });
});
