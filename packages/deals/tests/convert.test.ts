/**
 * Convert tests — deal → invoice loop that closes.
 *
 * Covers:
 *   - convertDealToInvoice (multi-line + single-value)
 *   - payment feedback (invoice → deal activity)
 *   - shouldPromptWon (fully-paid → prompt, not force)
 *   - Won prompt on terminal deal = null (no prompt)
 *   - Won prompt when no paid invoice = null
 */

import { describe, it, expect } from "vitest";
import {
  convertDealToInvoice,
  buildPaymentFeedback,
  buildWonPrompt,
  shouldPromptWon,
  ConvertError,
} from "../src/convert.js";
import { createDeal } from "../src/pipeline.js";
import { money } from "@supa/money/money";
import type { WorkspaceId } from "@supa/workspace-core/workspace";

const WS = "00000000-0000-0000-0000-000000000001" as WorkspaceId;
const NOW = 1_700_000_000_000;

describe("convertDealToInvoice", () => {
  it("converts a multi-line deal to an invoice draft", () => {
    const result = convertDealToInvoice({
      dealId: "deal-1",
      wsId: WS,
      customerId: "cust-1",
      profileId: "p1",
      title: "Q2 Retainer",
      currency: "NGN",
      taxMode: "per-line",
      dueInDays: 30,
      lineItems: [
        { description: "Design", net: money("10000.00", "NGN"), quantity: 1n },
        { description: "Dev", net: money("20000.00", "NGN"), quantity: 2n },
      ],
      singleValue: null,
    }, "inv-1", "user-1", NOW);

    expect(result.invoiceInput.id).toBe("inv-1");
    expect(result.invoiceInput.lineItems).toHaveLength(2);
    expect(result.invoiceInput.lineItems[0]!.description).toBe("Design");
    expect(result.invoiceInput.lineItems[1]!.description).toBe("Dev");
    expect(result.invoiceInput.currency).toBe("NGN");
    expect(result.invoiceInput.taxMode).toBe("per-line");
    expect(result.invoiceInput.dueInDays).toBe(30);

    expect(result.dealInvoiceLink.dealId).toBe("deal-1");
    expect(result.dealInvoiceLink.invoiceId).toBe("inv-1");
    expect(result.dealInvoiceLink.convertedAt).toBe(NOW);
    expect(result.dealInvoiceLink.convertedBy).toBe("user-1");
  });

  it("converts a single-value deal to a single-line invoice", () => {
    const result = convertDealToInvoice({
      dealId: "deal-1",
      wsId: WS,
      customerId: "cust-1",
      profileId: "p1",
      title: "Simple Deal",
      currency: "NGN",
      taxMode: "per-invoice",
      dueInDays: 14,
      lineItems: null,
      singleValue: money("5000.00", "NGN"),
    }, "inv-1", "user-1", NOW);

    expect(result.invoiceInput.lineItems).toHaveLength(1);
    expect(result.invoiceInput.lineItems[0]!.description).toBe("Simple Deal");
    expect(result.invoiceInput.lineItems[0]!.net.minor).toBe(500_000n);
    expect(result.invoiceInput.lineItems[0]!.quantity).toBe(1n);
  });

  it("throws if no line items and no single value", () => {
    expect(() =>
      convertDealToInvoice({
        dealId: "deal-1",
        wsId: WS,
        customerId: null,
        profileId: "p1",
        title: "Empty",
        currency: "NGN",
        taxMode: "per-line",
        dueInDays: 30,
        lineItems: null,
        singleValue: null,
      }, "inv-1", "user-1", NOW),
    ).toThrow(ConvertError);
  });

  it("carries line item discount + taxRate into the invoice", () => {
    const result = convertDealToInvoice({
      dealId: "deal-1",
      wsId: WS,
      customerId: "cust-1",
      profileId: "p1",
      title: "Deal",
      currency: "NGN",
      taxMode: "per-line",
      dueInDays: 30,
      lineItems: [
        {
          description: "Item with discount",
          net: money("10000.00", "NGN"),
          quantity: 1n,
          discount: money("1000.00", "NGN"),
          taxRate: "0.075",
        },
      ],
      singleValue: null,
    }, "inv-1", "user-1", NOW);

    const li = result.invoiceInput.lineItems[0]!;
    expect(li.discount).toBeDefined();
    expect(li.discount!.minor).toBe(100_000n); // 1000 NGN
    expect(li.taxRate).toBe("0.075");
  });
});

describe("buildPaymentFeedback", () => {
  it("builds the payment feedback for the deal timeline", () => {
    const fb = buildPaymentFeedback("deal-1", "inv-1", "INV-0042", "₦45,000", NOW);
    expect(fb.dealId).toBe("deal-1");
    expect(fb.invoiceId).toBe("inv-1");
    expect(fb.invoiceNumber).toBe("INV-0042");
    expect(fb.amountDisplay).toBe("₦45,000");
    expect(fb.paidAt).toBe(NOW);
  });
});

describe("shouldPromptWon — prompt, not force", () => {
  function makeDeal(stageId: string = "proposal") {
    return createDeal({
      id: "deal-1",
      wsId: WS,
      customerId: "cust-1",
      title: "Deal",
      value: money("10000.00", "NGN"),
      expectedClose: NOW + 30 * 86_400_000,
      stageId,
      probability: null,
      source: "manual",
      owner: "user-1",
    }, NOW);
  }

  it("returns a WonPrompt when a linked invoice is fully paid", () => {
    const deal = makeDeal("proposal");
    const invoices = [{ id: "inv-1", number: "INV-0042", status: "paid" }];
    const prompt = shouldPromptWon(deal, invoices);
    expect(prompt).not.toBeNull();
    expect(prompt!.dealId).toBe("deal-1");
    expect(prompt!.invoiceId).toBe("inv-1");
    expect(prompt!.invoiceNumber).toBe("INV-0042");
    expect(prompt!.reason).toBe("invoice-fully-paid");
  });

  it("returns null when the deal is already Won (no prompt)", () => {
    const deal = makeDeal("won");
    const invoices = [{ id: "inv-1", number: "INV-0042", status: "paid" }];
    expect(shouldPromptWon(deal, invoices)).toBeNull();
  });

  it("returns null when the deal is already Lost (no prompt)", () => {
    const deal = makeDeal("lost");
    const invoices = [{ id: "inv-1", number: "INV-0042", status: "paid" }];
    expect(shouldPromptWon(deal, invoices)).toBeNull();
  });

  it("returns null when no linked invoice is fully paid", () => {
    const deal = makeDeal("proposal");
    const invoices = [{ id: "inv-1", number: "INV-0042", status: "issued" }];
    expect(shouldPromptWon(deal, invoices)).toBeNull();
  });

  it("returns null when no linked invoices at all", () => {
    const deal = makeDeal("proposal");
    expect(shouldPromptWon(deal, [])).toBeNull();
  });
});

describe("buildWonPrompt", () => {
  it("builds a won prompt", () => {
    const prompt = buildWonPrompt("deal-1", "inv-1", "INV-0042", NOW);
    expect(prompt.dealId).toBe("deal-1");
    expect(prompt.invoiceId).toBe("inv-1");
    expect(prompt.invoiceNumber).toBe("INV-0042");
    expect(prompt.reason).toBe("invoice-fully-paid");
    expect(prompt.promptedAt).toBe(NOW);
  });
});
