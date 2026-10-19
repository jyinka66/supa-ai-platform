/**
 * Expense record + lifecycle tests.
 */

import { describe, it, expect } from "vitest";
import {
  createDraft,
  record,
  approve,
  reject,
  reimburse,
  resubmit,
  updateDraft,
  canTransition,
  queryReimbursements,
  DEFAULT_CATEGORIES,
  InvalidExpenseTransitionError,
  type CreateExpenseInput,
} from "../src/expense.js";
import { money } from "@supa/money/money";
import type { WorkspaceId } from "@supa/workspace-core/workspace";

const WS = "00000000-0000-0000-0000-000000000001" as WorkspaceId;
const NOW = 1_700_000_000_000;

function makeInput(overrides?: Partial<CreateExpenseInput>): CreateExpenseInput {
  return {
    id: "exp-1",
    wsId: WS,
    profileId: "p1",
    merchant: "GTBank Fuel Station",
    amount: money("5000.00", "NGN"),
    date: NOW,
    category: "transport",
    taxDeductible: true,
    taxRate: "0.075",
    receiptRef: null,
    recurringRuleId: null,
    recurringPeriodKey: null,
    mileage: null,
    createdBy: "user-1",
    paidBy: "cash",
    ...overrides,
  };
}

describe("createDraft", () => {
  it("creates a draft with status=draft", () => {
    const e = createDraft(makeInput(), NOW);
    expect(e.status).toBe("draft");
    expect(e.merchant).toBe("GTBank Fuel Station");
    expect(e.amount.minor).toBe(500_000n);
    expect(e.taxRate).toBe("0.075");
    expect(e.reimbursedAt).toBeNull();
  });

  it("trims merchant name", () => {
    const e = createDraft(makeInput({ merchant: "  Spaced  " }), NOW);
    expect(e.merchant).toBe("Spaced");
  });
});

describe("DEFAULT_CATEGORIES — SME reality", () => {
  it("includes transport, supplies, rent, utilities, salary, data/airtime, professional", () => {
    expect(DEFAULT_CATEGORIES).toContain("transport");
    expect(DEFAULT_CATEGORIES).toContain("supplies");
    expect(DEFAULT_CATEGORIES).toContain("rent");
    expect(DEFAULT_CATEGORIES).toContain("utilities");
    expect(DEFAULT_CATEGORIES).toContain("salary");
    expect(DEFAULT_CATEGORIES).toContain("data/airtime");
    expect(DEFAULT_CATEGORIES).toContain("professional");
  });
});

describe("status transitions", () => {
  it("draft → recorded", () => {
    const e = createDraft(makeInput(), NOW);
    const r = record(e, NOW + 1000);
    expect(r.status).toBe("recorded");
  });

  it("recorded → approved", () => {
    const e = record(createDraft(makeInput(), NOW), NOW);
    const a = approve(e, NOW + 1000);
    expect(a.status).toBe("approved");
  });

  it("recorded → rejected", () => {
    const e = record(createDraft(makeInput(), NOW), NOW);
    const r = reject(e, NOW + 1000);
    expect(r.status).toBe("rejected");
  });

  it("approved → reimbursed (sets reimbursedAt)", () => {
    const e = approve(record(createDraft(makeInput(), NOW), NOW), NOW);
    const r = reimburse(e, NOW + 1000);
    expect(r.status).toBe("reimbursed");
    expect(r.reimbursedAt).toBe(NOW + 1000);
  });

  it("rejected → recorded (re-submit)", () => {
    const e = reject(record(createDraft(makeInput(), NOW), NOW), NOW);
    const r = resubmit(e, NOW + 1000);
    expect(r.status).toBe("recorded");
  });

  it("draft → approved throws (must record first)", () => {
    const e = createDraft(makeInput(), NOW);
    expect(() => approve(e, NOW)).toThrow(InvalidExpenseTransitionError);
  });

  it("reimbursed is terminal", () => {
    const e = reimburse(approve(record(createDraft(makeInput(), NOW), NOW), NOW), NOW);
    expect(() => record(e, NOW)).toThrow(InvalidExpenseTransitionError);
    expect(() => approve(e, NOW)).toThrow(InvalidExpenseTransitionError);
    expect(() => reject(e, NOW)).toThrow(InvalidExpenseTransitionError);
  });
});

describe("updateDraft", () => {
  it("updates fields on a draft (still editing — costs nothing)", () => {
    const e = createDraft(makeInput(), NOW);
    const u = updateDraft(e, { merchant: "New Merchant", paidBy: "bank" }, NOW + 1000);
    expect(u.merchant).toBe("New Merchant");
    expect(u.paidBy).toBe("bank");
    expect(u.updatedAt).toBe(NOW + 1000);
  });

  it("throws on non-draft", () => {
    const e = record(createDraft(makeInput(), NOW), NOW);
    expect(() => updateDraft(e, { merchant: "X" }, NOW)).toThrow(InvalidExpenseTransitionError);
  });
});

describe("queryReimbursements — what do I owe myself/staff?", () => {
  it("returns approved (owed) + reimbursed (paid)", () => {
    const draft = createDraft(makeInput({ id: "d1" }), NOW);
    const approved = approve(record(createDraft(makeInput({ id: "d2" }), NOW), NOW), NOW);
    const reimbursed = reimburse(approve(record(createDraft(makeInput({ id: "d3" }), NOW), NOW), NOW), NOW);
    const summary = queryReimbursements([draft, approved, reimbursed]);
    expect(summary.owedCount).toBe(1); // approved, not yet reimbursed
    expect(summary.reimbursedCount).toBe(1);
    expect(summary.owed[0]?.id).toBe("d2");
    expect(summary.reimbursed[0]?.id).toBe("d3");
  });
});

describe("canTransition — the matrix", () => {
  it("draft can go to recorded or draft", () => {
    expect(canTransition("draft", "recorded")).toBe(true);
    expect(canTransition("draft", "draft")).toBe(true);
    expect(canTransition("draft", "approved")).toBe(false);
  });

  it("recorded can go to approved or rejected", () => {
    expect(canTransition("recorded", "approved")).toBe(true);
    expect(canTransition("recorded", "rejected")).toBe(true);
  });

  it("rejected can go to recorded (re-submit)", () => {
    expect(canTransition("rejected", "recorded")).toBe(true);
  });

  it("reimbursed is terminal", () => {
    expect(canTransition("reimbursed", "recorded")).toBe(false);
    expect(canTransition("reimbursed", "approved")).toBe(false);
  });
});

describe("tax rate recorded at entry — reproducible tax report", () => {
  it("stores the taxRate at entry time", () => {
    const e = createDraft(makeInput({ taxRate: "0.075" }), NOW);
    expect(e.taxRate).toBe("0.075");
    // Even if the rate changes next year, this expense shows the rate in effect when incurred.
  });

  it("allows null taxRate (non-deductible)", () => {
    const e = createDraft(makeInput({ taxDeductible: false, taxRate: null }), NOW);
    expect(e.taxDeductible).toBe(false);
    expect(e.taxRate).toBeNull();
  });
});
