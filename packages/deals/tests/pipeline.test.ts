/**
 * Pipeline tests.
 *
 * Covers:
 *   - DEFAULT_STAGES (Won/Lost terminal)
 *   - validatePipeline (Won/Lost required, terminal, contiguous orders)
 *   - canMoveStage (can't leave terminal)
 *   - Deal creation + stage moves
 *   - effectiveProbability (user-set vs stage-default — honest numbers)
 *   - weightedValue (value × probability, banker's rounding)
 *   - computePipelineTotals (per-stage + cross-currency)
 *   - StageMoveFact (free analytics)
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_STAGES,
  validatePipeline,
  findStage,
  canMoveStage,
  createDeal,
  moveStage,
  setProbability,
  clearProbability,
  effectiveProbability,
  weightedValue,
  computePipelineTotals,
  buildStageMoveActivity,
  type Pipeline,
  type Deal,
  type CreateDealInput,
} from "../src/pipeline.js";
import type { WorkspaceId } from "@supa/workspace-core/workspace";
import { money, fromMinor, asCurrency, type Rate } from "@supa/money/money";

const WS = "00000000-0000-0000-0000-000000000001" as WorkspaceId;
const NOW = 1_700_000_000_000;

function makePipeline(stages = DEFAULT_STAGES): Pipeline {
  return { wsId: WS, stages };
}

function makeDeal(overrides?: Partial<CreateDealInput>): Deal {
  return createDeal({
    id: "deal-1",
    wsId: WS,
    customerId: "cust-1",
    title: "Q2 Retainer",
    value: money("10000.00", "NGN"),
    expectedClose: NOW + 30 * 86_400_000,
    stageId: "new",
    probability: null,
    source: "manual",
    owner: "user-1",
    ...overrides,
  }, NOW);
}

// ───────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────

describe("DEFAULT_STAGES", () => {
  it("has 6 stages in order", () => {
    expect(DEFAULT_STAGES).toHaveLength(6);
    expect(DEFAULT_STAGES.map((s) => s.id)).toEqual([
      "new", "qualified", "proposal", "negotiation", "won", "lost",
    ]);
  });

  it("Won is terminal + won=true", () => {
    const won = DEFAULT_STAGES.find((s) => s.id === "won")!;
    expect(won.terminal).toBe(true);
    expect(won.won).toBe(true);
    expect(won.defaultProbability).toBe(1.0);
  });

  it("Lost is terminal + lost=true", () => {
    const lost = DEFAULT_STAGES.find((s) => s.id === "lost")!;
    expect(lost.terminal).toBe(true);
    expect(lost.lost).toBe(true);
    expect(lost.defaultProbability).toBe(0.0);
  });

  it("non-terminal stages have probabilities 0..1", () => {
    for (const s of DEFAULT_STAGES) {
      if (!s.terminal) {
        expect(s.defaultProbability).toBeGreaterThan(0);
        expect(s.defaultProbability).toBeLessThan(1);
      }
    }
  });
});

describe("validatePipeline", () => {
  it("passes for the default pipeline", () => {
    expect(validatePipeline(makePipeline())).toEqual({ ok: true });
  });

  it("fails if 'won' stage is missing", () => {
    const stages = DEFAULT_STAGES.filter((s) => s.id !== "won");
    const result = validatePipeline({ wsId: WS, stages });
    expect(result.ok).toBe(false);
    expect((result as { errors: string[] }).errors).toContain("pipeline must have a 'won' stage");
  });

  it("fails if 'lost' stage is missing", () => {
    const stages = DEFAULT_STAGES.filter((s) => s.id !== "lost");
    const result = validatePipeline({ wsId: WS, stages });
    expect(result.ok).toBe(false);
    expect((result as { errors: string[] }).errors).toContain("pipeline must have a 'lost' stage");
  });

  it("fails if 'won' is not terminal", () => {
    const stages = DEFAULT_STAGES.map((s) =>
      s.id === "won" ? { ...s, terminal: false } : s,
    );
    const result = validatePipeline({ wsId: WS, stages });
    expect(result.ok).toBe(false);
    expect((result as { errors: string[] }).errors).toContain("'won' stage must be terminal");
  });

  it("fails if orders are not contiguous", () => {
    const stages = DEFAULT_STAGES.map((s, i) => ({ ...s, order: i * 2 }));
    const result = validatePipeline({ wsId: WS, stages });
    expect(result.ok).toBe(false);
  });
});

describe("canMoveStage", () => {
  it("can move from non-terminal to any stage", () => {
    const p = makePipeline();
    expect(canMoveStage(p, "new", "qualified")).toBe(true);
    expect(canMoveStage(p, "new", "won")).toBe(true);
    expect(canMoveStage(p, "qualified", "proposal")).toBe(true);
  });

  it("cannot move FROM a terminal stage (Won/Lost are sinks)", () => {
    const p = makePipeline();
    expect(canMoveStage(p, "won", "new")).toBe(false);
    expect(canMoveStage(p, "won", "lost")).toBe(false);
    expect(canMoveStage(p, "lost", "new")).toBe(false);
  });

  it("returns false for unknown stages", () => {
    const p = makePipeline();
    expect(canMoveStage(p, "unknown", "new")).toBe(false);
    expect(canMoveStage(p, "new", "unknown")).toBe(false);
  });
});

describe("createDeal + moveStage", () => {
  it("creates a deal with all fields", () => {
    const d = makeDeal();
    expect(d.title).toBe("Q2 Retainer");
    expect(d.value.minor).toBe(1_000_000n); // 10000.00 NGN = 1M kobo
    expect(d.stageId).toBe("new");
    expect(d.probability).toBeNull();
    expect(d.source).toBe("manual");
  });

  it("trims title", () => {
    const d = makeDeal({ title: "  Spaced  " });
    expect(d.title).toBe("Spaced");
  });

  it("moveStage updates stageId + updatedAt", () => {
    const d = makeDeal();
    const moved = moveStage(d, "qualified", makePipeline(), NOW + 1000);
    expect(moved.stageId).toBe("qualified");
    expect(moved.updatedAt).toBe(NOW + 1000);
  });

  it("moveStage throws on invalid move (from terminal)", () => {
    const d = makeDeal({ stageId: "won" });
    expect(() => moveStage(d, "new", makePipeline(), NOW)).toThrow();
  });
});

describe("effectiveProbability — honest numbers", () => {
  it("uses user-set probability when present", () => {
    const d = makeDeal({ probability: 0.9 });
    const { probability, source } = effectiveProbability(d, makePipeline());
    expect(probability).toBe(0.9);
    expect(source).toBe("user");
  });

  it("uses stage default when user-set is null", () => {
    const d = makeDeal({ stageId: "qualified", probability: null });
    const { probability, source } = effectiveProbability(d, makePipeline());
    expect(probability).toBe(0.25); // qualified's defaultProbability
    expect(source).toBe("stage-default");
  });

  it("returns 0 for unknown stage", () => {
    const d = makeDeal({ stageId: "unknown", probability: null });
    const { probability } = effectiveProbability(d, makePipeline());
    expect(probability).toBe(0);
  });
});

describe("weightedValue", () => {
  it("value × user-set probability", () => {
    const d = makeDeal({ value: money("10000.00", "NGN"), probability: 0.5 });
    const wv = weightedValue(d, makePipeline());
    // 10000 NGN × 0.5 = 5000 NGN = 500000 kobo
    expect(wv.minor).toBe(500_000n);
    expect(wv.currency).toBe("NGN");
  });

  it("value × stage default probability", () => {
    const d = makeDeal({ value: money("10000.00", "NGN"), stageId: "qualified", probability: null });
    const wv = weightedValue(d, makePipeline());
    // 10000 × 0.25 = 2500 NGN = 250000 kobo
    expect(wv.minor).toBe(250_000n);
  });

  it("Won stage → weighted = value (prob=1.0)", () => {
    const d = makeDeal({ value: money("10000.00", "NGN"), stageId: "won", probability: null });
    const wv = weightedValue(d, makePipeline());
    expect(wv.minor).toBe(1_000_000n);
  });

  it("Lost stage → weighted = 0 (prob=0.0)", () => {
    const d = makeDeal({ value: money("10000.00", "NGN"), stageId: "lost", probability: null });
    const wv = weightedValue(d, makePipeline());
    expect(wv.minor).toBe(0n);
  });
});

describe("setProbability + clearProbability", () => {
  it("setProbability sets user probability", () => {
    const d = makeDeal({ probability: null });
    const updated = setProbability(d, 0.8, NOW + 1000);
    expect(updated.probability).toBe(0.8);
    expect(updated.updatedAt).toBe(NOW + 1000);
  });

  it("setProbability rejects out-of-range", () => {
    const d = makeDeal();
    expect(() => setProbability(d, -0.1)).toThrow();
    expect(() => setProbability(d, 1.1)).toThrow();
  });

  it("clearProbability reverts to stage default", () => {
    const d = makeDeal({ probability: 0.8 });
    const cleared = clearProbability(d, NOW + 1000);
    expect(cleared.probability).toBeNull();
    // effectiveProbability now uses stage default.
    const { source } = effectiveProbability(cleared, makePipeline());
    expect(source).toBe("stage-default");
  });
});

describe("computePipelineTotals — cross-currency at as-of rates", () => {
  it("sums per-stage totals in native currency", () => {
    const deals = [
      makeDeal({ id: "d1", value: money("10000.00", "NGN"), stageId: "new" }),
      makeDeal({ id: "d2", value: money("5000.00", "NGN"), stageId: "new" }),
    ];
    const totals = computePipelineTotals(deals, makePipeline(), asCurrency("NGN"), new Map());
    const newStage = totals.perStage.get("new")!;
    expect(newStage.count).toBe(2);
    expect(newStage.total.minor).toBe(1_500_000n); // 15000 NGN
  });

  it("weighted total = sum of weighted values", () => {
    const deals = [
      makeDeal({ id: "d1", value: money("10000.00", "NGN"), stageId: "new", probability: null }), // 10% → 1000
      makeDeal({ id: "d2", value: money("10000.00", "NGN"), stageId: "qualified", probability: null }), // 25% → 2500
    ];
    const totals = computePipelineTotals(deals, makePipeline(), asCurrency("NGN"), new Map());
    // 1000 + 2500 = 3500 NGN = 350000 kobo
    expect(totals.weightedTotal.minor).toBe(350_000n);
  });

  it("base total = sum when all same currency", () => {
    const deals = [
      makeDeal({ id: "d1", value: money("10000.00", "NGN"), stageId: "new" }),
      makeDeal({ id: "d2", value: money("5000.00", "NGN"), stageId: "new" }),
    ];
    const totals = computePipelineTotals(deals, makePipeline(), asCurrency("NGN"), new Map());
    expect(totals.baseTotal.minor).toBe(1_500_000n); // 15000 NGN, no conversion needed
  });

  it("converts cross-currency at recorded rates (no silent FX)", () => {
    const usdDeal = makeDeal({ id: "d1", value: money("100.00", "USD"), stageId: "new" });
    const rate: Rate = {
      from: asCurrency("USD"),
      to: asCurrency("NGN"),
      rate: "1500", // 1 USD = 1500 NGN
      asOf: NOW,
      source: "provider",
    };
    const totals = computePipelineTotals([usdDeal], makePipeline(), asCurrency("NGN"), new Map([[asCurrency("USD"), rate]]));
    // 100 USD × 1500 = 150000 NGN = 15000000 kobo
    expect(totals.baseTotal.minor).toBe(15_000_000n);
    // The conversion is recorded — hover-to-show-originals.
    expect(totals.conversions[0]!.rate).toBe(rate);
  });

  it("records gap honestly when no rate available (not silent)", () => {
    const usdDeal = makeDeal({ id: "d1", value: money("100.00", "USD"), stageId: "new" });
    const totals = computePipelineTotals([usdDeal], makePipeline(), asCurrency("NGN"), new Map());
    // No rate → base total is 0 (gap recorded, not silent).
    expect(totals.baseTotal.minor).toBe(0n);
    expect(totals.conversions[0]!.rate).toBeUndefined();
  });
});

describe("buildStageMoveActivity — free analytics", () => {
  it("records the stage move for the activity feed", () => {
    const fact = buildStageMoveActivity("deal-1", "new", "qualified", "user-1", NOW);
    expect(fact.dealId).toBe("deal-1");
    expect(fact.fromStageId).toBe("new");
    expect(fact.toStageId).toBe("qualified");
    expect(fact.actor).toBe("user-1");
    expect(fact.movedAt).toBe(NOW);
  });
});
