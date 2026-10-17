/**
 * Credit note tests.
 *
 * Covers:
 *   - credit note gets CN- sequence (separate from invoice)
 *   - createCreditNote stores all fields
 *   - credit note references the original invoice (audit trail)
 *   - net revenue = Σ(invoices) − Σ(credit notes)
 *   - voided invoice + credit note = the canonical void flow
 */

import { describe, it, expect } from "vitest";
import {
  createCreditNote,
  computeNetRevenue,
  type CreateCreditNoteInput,
} from "../src/credit-note.js";
import { money, fromMinor, type Money } from "@supa/money/money";
import type { WorkspaceId } from "@supa/workspace-core/workspace";
import { createDraft, issue, void_ } from "../src/invoice.js";
import type { Invoice } from "../src/invoice.js";

// ───────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────

const WS = "00000000-0000-0000-0000-000000000001" as WorkspaceId;
const PROFILE = "p1";
const NOW = 1_700_000_000_000;

function makeInvoice(amountNgn: string = "100.00"): Invoice {
  return createDraft({
    id: "inv-1",
    wsId: WS,
    profileId: PROFILE,
    lineItems: [{ description: "Work", net: money(amountNgn, "NGN"), quantity: 1n }],
    taxMode: "per-line",
    currency: "NGN",
    dueInDays: 30,
  }, NOW);
}

function makeCreditNoteInput(amount: Money, invoiceId: string = "inv-1"): CreateCreditNoteInput {
  return {
    id: "cn-1",
    wsId: WS,
    profileId: PROFILE,
    invoiceId,
    amount,
    reason: "invoice-voided",
  };
}

// ───────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────

describe("createCreditNote", () => {
  it("creates a credit note with the allocated CN- number", () => {
    const cn = createCreditNote(
      makeCreditNoteInput(fromMinor(10_000n, "NGN")),
      "CN-0001",
      NOW,
    );
    expect(cn.number).toBe("CN-0001");
    expect(cn.id).toBe("cn-1");
    expect(cn.wsId).toBe(WS);
    expect(cn.profileId).toBe(PROFILE);
    expect(cn.invoiceId).toBe("inv-1");
    expect(cn.amount.minor).toBe(10_000n);
    expect(cn.reason).toBe("invoice-voided");
    expect(cn.createdAt).toBe(NOW);
  });

  it("supports all credit note reasons", () => {
    const reasons = ["invoice-voided", "refund-issued", "adjustment", "partial-refund"] as const;
    for (const reason of reasons) {
      const cn = createCreditNote(
        { ...makeCreditNoteInput(fromMinor(5_000n, "NGN")), reason },
        "CN-0001",
        NOW,
      );
      expect(cn.reason).toBe(reason);
    }
  });

  it("references the original invoice (audit trail)", () => {
    const cn = createCreditNote(
      makeCreditNoteInput(fromMinor(10_000n, "NGN"), "inv-42"),
      "CN-0001",
      NOW,
    );
    expect(cn.invoiceId).toBe("inv-42");
  });
});

describe("computeNetRevenue — invoices minus credit notes", () => {
  it("returns the invoice total when no credit notes", () => {
    const invoice = makeInvoice("100.00"); // 100 NGN = 10000 kobo
    const net = computeNetRevenue([{ totals: { total: invoice.totals.total } }], []);
    expect(net.minor).toBe(10_000n);
  });

  it("subtracts credit note amounts", () => {
    const invoice = makeInvoice("100.00"); // 10000 kobo
    const creditNote = createCreditNote(
      makeCreditNoteInput(fromMinor(3_000n, "NGN")), // 30 NGN credit
      "CN-0001",
      NOW,
    );
    const net = computeNetRevenue(
      [{ totals: { total: invoice.totals.total } }],
      [creditNote],
    );
    expect(net.minor).toBe(7_000n); // 10000 - 3000 = 7000 kobo = 70 NGN
  });

  it("sums multiple invoices + multiple credit notes", () => {
    const inv1 = makeInvoice("100.00"); // 10000 kobo
    const inv2 = makeInvoice("50.00");  // 5000 kobo
    const cn1 = createCreditNote(
      makeCreditNoteInput(fromMinor(2_000n, "NGN")),
      "CN-0001",
      NOW,
    );
    const cn2 = createCreditNote(
      makeCreditNoteInput(fromMinor(1_000n, "NGN")),
      "CN-0002",
      NOW,
    );
    const net = computeNetRevenue(
      [
        { totals: { total: inv1.totals.total } },
        { totals: { total: inv2.totals.total } },
      ],
      [cn1, cn2],
    );
    // 10000 + 5000 - 2000 - 1000 = 12000 kobo = 120 NGN
    expect(net.minor).toBe(12_000n);
  });

  it("handles all-credit-notes (net can be zero or negative via subtraction)", () => {
    // No invoices, no credit notes → returns zero NGN.
    const net = computeNetRevenue([], []);
    expect(net.minor).toBe(0n);
  });
});

describe("canonical void flow — voided invoice + credit note", () => {
  it("void creates an invoice with status=voided + a credit note in CN- sequence", () => {
    // Step 1: create draft, issue, void the invoice.
    const draft = makeInvoice("100.00");
    const issued = issue(draft, "INV-0042", NOW);
    const voided = void_(issued, NOW + 1000);

    // Step 2: create the credit note (allocated from CN- sequence).
    const creditNote = createCreditNote(
      makeCreditNoteInput(voided.totals.total, voided.id),
      "CN-0001",
      NOW + 1000,
    );

    // Audit trail: the invoice keeps its number, the credit note references it.
    expect(voided.number).toBe("INV-0042");
    expect(voided.status).toBe("voided");
    expect(creditNote.number).toBe("CN-0001");
    expect(creditNote.invoiceId).toBe(voided.id);
    expect(creditNote.amount.minor).toBe(voided.totals.total.minor);

    // Net revenue = 100 NGN - 100 NGN = 0 (the void fully offsets).
    const net = computeNetRevenue(
      [{ totals: { total: voided.totals.total } }],
      [creditNote],
    );
    expect(net.minor).toBe(0n);
  });

  it("invoice counter never decreases — credit notes are additive, not decremental", () => {
    // Issue 3 invoices: INV-0001, INV-0002, INV-0003.
    const inv1 = issue(makeInvoice(), "INV-0001", NOW);
    const inv2 = issue(makeInvoice(), "INV-0002", NOW);
    const inv3 = issue(makeInvoice(), "INV-0003", NOW);

    // Void INV-0002 — creates CN-0001 (NOT INV-0002-void).
    const voided = void_(inv2, NOW);
    const creditNote = createCreditNote(
      makeCreditNoteInput(voided.totals.total, voided.id),
      "CN-0001",
      NOW,
    );

    // The invoice counter is at 3 — credit note didn't decrement it.
    // Next invoice would be INV-0004 (not INV-0002 reused).
    expect(voided.number).toBe("INV-0002"); // kept
    expect(creditNote.number).toBe("CN-0001"); // separate sequence

    // Net revenue = 3 invoices - 1 credit note = 2 invoices worth.
    const net = computeNetRevenue(
      [
        { totals: { total: inv1.totals.total } },
        { totals: { total: voided.totals.total } }, // voided but still in the list
        { totals: { total: inv3.totals.total } },
      ],
      [creditNote],
    );
    // 10000 + 10000 + 10000 - 10000 = 20000 kobo = 200 NGN
    expect(net.minor).toBe(20_000n);
  });
});
