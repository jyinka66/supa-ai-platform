/**
 * Receipts + OCR + Mileage + Recurring tests.
 */

import { describe, it, expect } from "vitest";
import {
  InMemoryReceiptStore,
  validateReceipt,
  createQueuedDraft,
  markUploaded,
  DEFAULT_RECEIPT_LIMITS,
} from "../src/receipts.js";
import {
  makeOcrField,
  isAboveThreshold,
  buildConfirmation,
  buildQualitySignal,
  DEFAULT_CONFIRMATION_THRESHOLD,
  type OcrExtraction,
} from "../src/ocr.js";
import {
  computePeriodKey,
  materializeInstance,
  computeNextDueDate,
  type RecurringExpenseRule,
} from "../src/recurring.js";
import {
  computeMileageAmount,
  getCountryDefaultRate,
  gpsCaptureToEntry,
  COUNTRY_DEFAULT_RATES,
  type MileageEntry,
} from "../src/mileage.js";
import {
  approvalFlowApplies,
  recordApprovalDecision,
  recordReimbursement,
  buildApprovalActivity,
} from "../src/approval.js";
import { createDraft, record, approve, type Expense } from "../src/expense.js";
import { money } from "@supa/money/money";
import { asCurrency } from "@supa/money/money";
import type { WorkspaceId } from "@supa/workspace-core/workspace";

const WS = "00000000-0000-0000-0000-000000000001" as WorkspaceId;
const NOW = 1_700_000_000_000;

// ─── Receipts ───

describe("InMemoryReceiptStore — content-addressed", () => {
  it("same bytes → same hash, stored once", async () => {
    const store = new InMemoryReceiptStore();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const h1 = await store.store(bytes);
    const h2 = await store.store(bytes); // same bytes
    expect(h1).toBe(h2); // idempotent
    expect(await store.exists(h1)).toBe(true);
  });

  it("different bytes → different hash", async () => {
    const store = new InMemoryReceiptStore();
    const h1 = await store.store(new Uint8Array([1, 2, 3]));
    const h2 = await store.store(new Uint8Array([4, 5, 6]));
    expect(h1).not.toBe(h2);
  });

  it("fetch returns the bytes", async () => {
    const store = new InMemoryReceiptStore();
    const bytes = new Uint8Array([10, 20, 30]);
    const h = await store.store(bytes);
    const fetched = await store.fetch(h);
    expect(fetched).toEqual(bytes);
  });

  it("fetch returns null for unknown hash", async () => {
    const store = new InMemoryReceiptStore();
    expect(await store.fetch("unknown")).toBeNull();
  });
});

describe("validateReceipt — decode caps + sanitization", () => {
  it("validates a small JPEG", () => {
    const result = validateReceipt(new Uint8Array(100), "image/jpeg");
    expect(result.ok).toBe(true);
    expect(result.hash).not.toBeNull();
  });

  it("rejects oversized files", () => {
    const result = validateReceipt(new Uint8Array(DEFAULT_RECEIPT_LIMITS.maxFileSize + 1), "image/jpeg");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("file size");
  });

  it("rejects disallowed MIME types (SVG = code, not image)", () => {
    const result = validateReceipt(new Uint8Array(100), "image/svg+xml");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("MIME type");
  });
});

describe("offline capture — draft + queued upload", () => {
  it("createQueuedDraft stores locally without uploading", () => {
    const draft = createQueuedDraft("d1", new Uint8Array([1, 2, 3]), "image/jpeg", NOW);
    expect(draft.uploaded).toBe(false);
    expect(draft.hash).toBeNull();
  });

  it("markUploaded sets uploaded + hash", () => {
    const draft = createQueuedDraft("d1", new Uint8Array([1, 2, 3]), "image/jpeg", NOW);
    const uploaded = markUploaded(draft, "abc123hash");
    expect(uploaded.uploaded).toBe(true);
    expect(uploaded.hash).toBe("abc123hash");
  });
});

// ─── OCR ───

describe("makeOcrField + isAboveThreshold", () => {
  it("high confidence is above threshold", () => {
    const f = makeOcrField("₦5,000", 0.95);
    expect(f.aboveThreshold).toBe(true);
    expect(isAboveThreshold(f)).toBe(true);
  });

  it("low confidence is below threshold", () => {
    const f = makeOcrField("₦5,000", 0.50);
    expect(f.aboveThreshold).toBe(false);
    expect(isAboveThreshold(f)).toBe(false);
  });

  it("null value with 0 confidence is below threshold", () => {
    const f = makeOcrField<string>(null, 0);
    expect(f.aboveThreshold).toBe(false);
  });
});

describe("buildConfirmation — propose, never write", () => {
  function makeExtraction(): OcrExtraction {
    return {
      receiptHash: "abc123",
      merchant: makeOcrField("GTBank Fuel", 0.9),
      amount: makeOcrField("5000.00", 0.85),
      currency: makeOcrField("NGN", 0.99),
      date: makeOcrField(NOW, 0.8),
      taxLine: makeOcrField("375.00", 0.7),
      attribution: {
        source: "ocr",
        modelVersion: "ocr-v1.2",
        extractedAt: NOW,
        costMicrocredits: 50,
      },
    };
  }

  it("builds a confirmation with accepted values (no edits)", () => {
    const extraction = makeExtraction();
    const confirmation = buildConfirmation(extraction, {}, "user-1", NOW + 1000);
    expect(confirmation.merchant).toBe("GTBank Fuel");
    expect(confirmation.amount).toBe("5000.00");
    expect(confirmation.currency).toBe("NGN");
    expect(confirmation.edits).toHaveLength(0); // no edits
  });

  it("records edits where user changed values", () => {
    const extraction = makeExtraction();
    const confirmation = buildConfirmation(extraction, { amount: "6000.00" }, "user-1", NOW + 1000);
    expect(confirmation.amount).toBe("6000.00"); // user-edited
    expect(confirmation.edits).toHaveLength(1);
    expect(confirmation.edits[0]!.field).toBe("amount");
    expect(confirmation.edits[0]!.ocrValue).toBe("5000.00");
    expect(confirmation.edits[0]!.confirmedValue).toBe("6000.00");
  });

  it("carries the extraction as attribution metadata", () => {
    const extraction = makeExtraction();
    const confirmation = buildConfirmation(extraction, {}, "user-1", NOW + 1000);
    expect(confirmation.extraction).toBe(extraction);
    expect(confirmation.extraction.attribution.modelVersion).toBe("ocr-v1.2");
  });
});

describe("buildQualitySignal — AI-quality channel", () => {
  it("computes edit rate per extraction", () => {
    const extraction: OcrExtraction = {
      receiptHash: "abc",
      merchant: makeOcrField("M", 0.9),
      amount: makeOcrField("5000", 0.8),
      currency: makeOcrField("NGN", 0.99),
      date: makeOcrField(NOW, 0.9),
      taxLine: makeOcrField<string>(null, 0.5),
      attribution: { source: "ocr", modelVersion: "v1", extractedAt: NOW, costMicrocredits: 50 },
    };
    const confirmation = buildConfirmation(extraction, { amount: "6000" }, "user-1", NOW + 1000);
    const signal = buildQualitySignal(confirmation);
    expect(signal.totalFields).toBe(5);
    expect(signal.editedFields).toBe(1); // amount was edited
    expect(signal.editRate).toBe(0.2); // 1/5
    expect(signal.fieldEdits.amount).toBe(true);
    expect(signal.fieldEdits.merchant).toBe(false);
  });

  it("0 edits = perfect OCR (editRate=0)", () => {
    const extraction: OcrExtraction = {
      receiptHash: "abc",
      merchant: makeOcrField("M", 0.9),
      amount: makeOcrField("5000", 0.9),
      currency: makeOcrField("NGN", 0.99),
      date: makeOcrField(NOW, 0.9),
      taxLine: makeOcrField<string>(null, 0.5),
      attribution: { source: "ocr", modelVersion: "v1", extractedAt: NOW, costMicrocredits: 50 },
    };
    const confirmation = buildConfirmation(extraction, {}, "user-1", NOW + 1000);
    const signal = buildQualitySignal(confirmation);
    expect(signal.editedFields).toBe(0);
    expect(signal.editRate).toBe(0);
  });
});

// ─── Mileage ───

describe("computeMileageAmount — distance × rate → Money", () => {
  it("computes 100km × ₦65/km = ₦6,500", () => {
    const entry: MileageEntry = {
      distanceKm: 100,
      ratePerKm: "65.00",
      currency: asCurrency("NGN"),
      origin: null,
      destination: null,
    };
    const amount = computeMileageAmount(entry);
    expect(amount.minor).toBe(650_000n); // 6500 NGN = 650000 kobo
    expect(amount.currency).toBe("NGN");
  });

  it("records the rate at entry time (reproducible tax report)", () => {
    const entry: MileageEntry = {
      distanceKm: 50,
      ratePerKm: "65.00",
      currency: asCurrency("NGN"),
      origin: "Lagos",
      destination: "Abuja",
    };
    const amount = computeMileageAmount(entry);
    // 50 × 65 = 3250 NGN = 325000 kobo
    expect(amount.minor).toBe(325_000n);
  });

  it("rejects negative distance", () => {
    expect(() => computeMileageAmount({
      distanceKm: -10,
      ratePerKm: "65.00",
      currency: asCurrency("NGN"),
      origin: null,
      destination: null,
    })).toThrow();
  });
});

describe("getCountryDefaultRate", () => {
  it("returns NG default", () => {
    const rate = getCountryDefaultRate("NG");
    expect(rate).not.toBeNull();
    expect(rate!.currency).toBe("NGN");
    expect(rate!.ratePerKm).toBe("65.00");
  });

  it("returns null for unknown country", () => {
    expect(getCountryDefaultRate("XX")).toBeNull();
  });
});

describe("gpsCaptureToEntry — GPS is convenience, not tracker", () => {
  it("converts GPS capture to a mileage entry", () => {
    const entry = gpsCaptureToEntry(
      { startedAt: NOW, endedAt: NOW + 3600000, distanceKm: 42.5, originAddress: "Lagos", destinationAddress: "Ibadan" },
      "65.00",
      asCurrency("NGN"),
    );
    expect(entry.distanceKm).toBe(42.5);
    expect(entry.ratePerKm).toBe("65.00");
    expect(entry.origin).toBe("Lagos");
    expect(entry.destination).toBe("Ibadan");
  });
});

// ─── Recurring ───

describe("computePeriodKey — idempotency", () => {
  it("monthly: 2024-03", () => {
    const mar = new Date("2024-03-15").getTime();
    expect(computePeriodKey(mar, "monthly")).toBe("2024-03");
  });

  it("daily: 2024-03-15", () => {
    const d = new Date("2024-03-15").getTime();
    expect(computePeriodKey(d, "daily")).toBe("2024-03-15");
  });

  it("yearly: 2024", () => {
    const d = new Date("2024-06-15").getTime();
    expect(computePeriodKey(d, "yearly")).toBe("2024");
  });

  it("same period → same key (idempotent)", () => {
    const d1 = new Date("2024-03-01").getTime();
    const d2 = new Date("2024-03-31").getTime();
    expect(computePeriodKey(d1, "monthly")).toBe(computePeriodKey(d2, "monthly"));
  });
});

describe("materializeInstance — idempotent per period key", () => {
  const rule: RecurringExpenseRule = {
    id: "rule-1",
    wsId: WS,
    profileId: "p1",
    merchant: "Landlord",
    amount: money("100000.00", "NGN"),
    category: "rent",
    taxDeductible: false,
    taxRate: null,
    frequency: "monthly",
    startDate: new Date("2024-01-01").getTime(),
    endDate: null,
    amountMode: "fixed",
    autoRecord: true,
    createdBy: "user-1",
    createdAt: NOW,
    active: true,
  };

  it("materializes an instance for a target date", () => {
    const mar = new Date("2024-03-15").getTime();
    const inst = materializeInstance(rule, mar);
    expect(inst).not.toBeNull();
    expect(inst!.periodKey).toBe("2024-03");
    expect(inst!.requiresConfirmation).toBe(false); // fixed + autoRecord
  });

  it("returns null if rule is paused", () => {
    const paused = { ...rule, active: false };
    expect(materializeInstance(paused, NOW)).toBeNull();
  });

  it("returns null if target is before start date", () => {
    const before = new Date("2023-12-31").getTime();
    expect(materializeInstance(rule, before)).toBeNull();
  });

  it("variable amount requires confirmation", () => {
    const variable = { ...rule, amountMode: "variable" as const };
    const mar = new Date("2024-03-15").getTime();
    const inst = materializeInstance(variable, mar);
    expect(inst!.requiresConfirmation).toBe(true);
  });
});

describe("computeNextDueDate", () => {
  it("monthly: Jan → Feb", () => {
    const rule: RecurringExpenseRule = {
      id: "r1", wsId: WS, profileId: "p1", merchant: "M", amount: money("100.00", "NGN"),
      category: "rent", taxDeductible: false, taxRate: null, frequency: "monthly",
      startDate: new Date("2024-01-15").getTime(), endDate: null, amountMode: "fixed",
      autoRecord: true, createdBy: "u", createdAt: NOW, active: true,
    };
    const next = computeNextDueDate(rule, new Date("2024-01-15").getTime());
    expect(next).not.toBeNull();
    const nextDate = new Date(next!);
    expect(nextDate.getUTCMonth()).toBe(1); // Feb (0-indexed)
  });

  it("returns null past end date", () => {
    const rule: RecurringExpenseRule = {
      id: "r1", wsId: WS, profileId: "p1", merchant: "M", amount: money("100.00", "NGN"),
      category: "rent", taxDeductible: false, taxRate: null, frequency: "monthly",
      startDate: new Date("2024-01-01").getTime(),
      endDate: new Date("2024-03-31").getTime(),
      amountMode: "fixed", autoRecord: true, createdBy: "u", createdAt: NOW, active: true,
    };
    expect(computeNextDueDate(rule, new Date("2024-03-15").getTime())).toBeNull();
  });
});

// ─── Approval ───

describe("approvalFlowApplies — team-only", () => {
  it("returns false for solo workspace (only owner)", () => {
    expect(approvalFlowApplies(new Set(["owner"]))).toBe(false);
  });

  it("returns true when workspace has members", () => {
    expect(approvalFlowApplies(new Set(["owner", "member"]))).toBe(true);
  });

  it("returns true when workspace has viewers", () => {
    expect(approvalFlowApplies(new Set(["owner", "viewer"]))).toBe(true);
  });
});

describe("recordApprovalDecision", () => {
  function makeRecordedExpense(): Expense {
    return record(createDraft({
      id: "exp-1", wsId: WS, profileId: "p1", merchant: "M", amount: money("5000.00", "NGN"),
      date: NOW, category: "transport", taxDeductible: true, taxRate: "0.075",
      receiptRef: null, recurringRuleId: null, recurringPeriodKey: null, mileage: null,
      createdBy: "user-1", paidBy: "cash",
    }, NOW), NOW);
  }

  it("approves a recorded expense", () => {
    const e = makeRecordedExpense();
    const { record: dec, expense: newE } = recordApprovalDecision(e, "approved", "owner-1", "Looks good", NOW + 1000);
    expect(newE.status).toBe("approved");
    expect(dec.decision).toBe("approved");
    expect(dec.note).toBe("Looks good");
    expect(dec.decidedBy).toBe("owner-1");
  });

  it("rejects a recorded expense", () => {
    const e = makeRecordedExpense();
    const { expense: newE } = recordApprovalDecision(e, "rejected", "owner-1", "Need receipt", NOW + 1000);
    expect(newE.status).toBe("rejected");
  });

  it("throws on non-recorded expense", () => {
    const e = createDraft({
      id: "exp-1", wsId: WS, profileId: "p1", merchant: "M", amount: money("5000.00", "NGN"),
      date: NOW, category: "transport", taxDeductible: true, taxRate: "0.075",
      receiptRef: null, recurringRuleId: null, recurringPeriodKey: null, mileage: null,
      createdBy: "user-1", paidBy: "cash",
    }, NOW);
    expect(() => recordApprovalDecision(e, "approved", "owner-1", null, NOW)).toThrow();
  });
});

describe("recordReimbursement", () => {
  it("reimburses an approved expense", () => {
    const e = approve(record(createDraft({
      id: "exp-1", wsId: WS, profileId: "p1", merchant: "M", amount: money("5000.00", "NGN"),
      date: NOW, category: "transport", taxDeductible: true, taxRate: "0.075",
      receiptRef: null, recurringRuleId: null, recurringPeriodKey: null, mileage: null,
      createdBy: "user-1", paidBy: "cash",
    }, NOW), NOW), NOW);

    const { record: rec, expense: newE } = recordReimbursement(e, "bank-tx-123", money("5000.00", "NGN"), "owner-1", NOW + 1000);
    expect(newE.status).toBe("reimbursed");
    expect(newE.reimbursedAt).toBe(NOW + 1000);
    expect(rec.paymentRef).toBe("bank-tx-123");
  });

  it("throws on non-approved expense", () => {
    const e = record(createDraft({
      id: "exp-1", wsId: WS, profileId: "p1", merchant: "M", amount: money("5000.00", "NGN"),
      date: NOW, category: "transport", taxDeductible: true, taxRate: "0.075",
      receiptRef: null, recurringRuleId: null, recurringPeriodKey: null, mileage: null,
      createdBy: "user-1", paidBy: "cash",
    }, NOW), NOW);
    expect(() => recordReimbursement(e, "tx", money("5000.00", "NGN"), "o", NOW)).toThrow();
  });
});

describe("buildApprovalActivity — timeline without separate audit log", () => {
  it("builds activity for approval decision", () => {
    // Start from a recorded expense (not pre-approved — recordApprovalDecision requires "recorded").
    const e = record(createDraft({
      id: "exp-1", wsId: WS, profileId: "p1", merchant: "M", amount: money("5000.00", "NGN"),
      date: NOW, category: "transport", taxDeductible: true, taxRate: "0.075",
      receiptRef: null, recurringRuleId: null, recurringPeriodKey: null, mileage: null,
      createdBy: "user-1", paidBy: "cash",
    }, NOW), NOW);
    const { record: dec } = recordApprovalDecision(e, "approved", "owner-1", "OK", NOW + 1000);
    const activity = buildApprovalActivity(dec);
    expect(activity.kind).toBe("expense-approved");
    expect(activity.expenseId).toBe("exp-1");
    expect(activity.actor).toBe("owner-1");
    expect(activity.note).toBe("OK");
  });
});
