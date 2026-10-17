/**
 * @supa/deals/convert
 * ----------------------------------------------------------------
 * Convert copies deal line items (or a single value) into an invoice
 *   draft linked to the deal and customer; the invoice's payment
 *   facts write back an activity fact on the deal, and a fully-paid
 *   invoice prompts (not forces) Won.
 *
 * The anchor thesis made concrete: the CRM feeds the invoice, the
 *   money facts flow back to the CRM, and the owner's mental model —
 *   "customer → deal → invoice → paid" — is literally the data flow.
 *   No separate "revenue from CRM" report needed; it's the same
 *   fact table filtered.
 * ----------------------------------------------------------------
 */

import type { WorkspaceId } from "@supa/workspace-core/workspace";
import type { Money } from "@supa/money/money";
import type { Deal } from "./pipeline.js";
import type { LineItem } from "@supa/invoicing/invoice";

// ───────────────────────────────────────────────
// Convert deal → invoice draft
// ───────────────────────────────────────────────

/**
 * A line item on a deal. Deals can carry line items (the quote
 * breakdown) OR a single value (simple deals). Both convert to
 * invoice line items.
 */
export interface DealLineItem {
  readonly description: string;
  readonly net: Money;
  readonly quantity: bigint;
  readonly discount?: Money | undefined;
  readonly taxRate?: string | undefined;
}

/**
 * The convert input. Either:
 *   - `lineItems` is provided (multi-line deal → multi-line invoice)
 *   - OR `singleValue` is provided (simple deal → single-line invoice)
 *
 * The invoice draft is linked to the deal (dealId) + customer
 * (customerId). The invoice's currency matches the deal's value
 * currency (the deal's native currency).
 */
export interface ConvertDealInput {
  readonly dealId: string;
  readonly wsId: WorkspaceId;
  readonly customerId: string | null;
  readonly profileId: string;
  readonly title: string;
  readonly currency: string;
  readonly taxMode: "per-line" | "per-invoice";
  readonly dueInDays: number;
  /** Multi-line deal: provide line items. */
  readonly lineItems: readonly DealLineItem[] | null;
  /** Simple deal: provide a single value (converted to a single-line invoice). */
  readonly singleValue: Money | null;
}

/**
 * The convert result. Returns the invoice draft input (to be passed
 * to the invoicing package's createDraft) + the activity facts to
 * write (deal_converted activity on the deal, linking it to the
 * invoice).
 */
export interface ConvertResult {
  /** The invoice draft input (for @supa/invoicing createDraft). */
  readonly invoiceInput: {
    readonly id: string;
    readonly wsId: WorkspaceId;
    readonly profileId: string;
    readonly lineItems: readonly LineItem[];
    readonly taxMode: "per-line" | "per-invoice";
    readonly currency: string;
    readonly dueInDays: number;
  };
  /** The deal→invoice link (stored on the deal for the audit trail). */
  readonly dealInvoiceLink: {
    readonly dealId: string;
    readonly invoiceId: string;
    readonly convertedAt: number;
    readonly convertedBy: string;
  };
}

/**
 * Convert a deal to an invoice draft.
 *
 * Copies deal line items (or a single value) into an invoice draft
 * linked to the deal + customer. The invoice's payment facts will
 * write back an activity fact on the deal (the loop that closes).
 */
export function convertDealToInvoice(
  input: ConvertDealInput,
  invoiceId: string,
  actor: string,
  now: number = Date.now(),
): ConvertResult {
  // Build the invoice line items from the deal.
  let invoiceLineItems: LineItem[];
  if (input.lineItems && input.lineItems.length > 0) {
    invoiceLineItems = input.lineItems.map((li) => ({
      description: li.description,
      net: li.net,
      quantity: li.quantity,
      ...(li.discount !== undefined ? { discount: li.discount } : {}),
      ...(li.taxRate !== undefined ? { taxRate: li.taxRate } : {}),
    }));
  } else if (input.singleValue) {
    // Simple deal → single-line invoice with the deal's title as description.
    invoiceLineItems = [
      {
        description: input.title,
        net: input.singleValue,
        quantity: 1n,
      },
    ];
  } else {
    throw new ConvertError("deal has no line items and no single value to convert");
  }

  return {
    invoiceInput: {
      id: invoiceId,
      wsId: input.wsId,
      profileId: input.profileId,
      lineItems: invoiceLineItems,
      taxMode: input.taxMode,
      currency: input.currency,
      dueInDays: input.dueInDays,
    },
    dealInvoiceLink: {
      dealId: input.dealId,
      invoiceId,
      convertedAt: now,
      convertedBy: actor,
    },
  };
}

export class ConvertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConvertError";
  }
}

// ───────────────────────────────────────────────
// Payment feedback loop — invoice → deal activity
// ───────────────────────────────────────────────

/**
 * When an invoice (linked to a deal) is paid, the invoicing pass's
 * payment fact write fans out an activity fact on the deal. This
 * is the loop that closes: CRM feeds invoice, money facts flow
 * back to CRM.
 *
 * The deal repository calls this when it receives a payment
 * notification for a linked invoice.
 */
export interface PaymentFeedback {
  readonly dealId: string;
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly amountDisplay: string;
  readonly paidAt: number;
}

export function buildPaymentFeedback(
  dealId: string,
  invoiceId: string,
  invoiceNumber: string,
  amountDisplay: string,
  paidAt: number,
): PaymentFeedback {
  return { dealId, invoiceId, invoiceNumber, amountDisplay, paidAt };
}

// ───────────────────────────────────────────────
// Fully-paid → prompt Won (not force)
// ───────────────────────────────────────────────

/**
 * When a deal's linked invoice is fully paid, the system PROMPTS
 * (not forces) the deal to Won. The prompt is a suggestion — the
 * owner decides. Some deals have partial payments that don't
 * close the deal; some have multiple invoices; the owner's judgment
 * is the final word.
 *
 * This function returns a prompt (not a stage move). The UI shows
 * "Invoice INV-0042 paid in full — move to Won?" The owner clicks
 * yes/no.
 */
export interface WonPrompt {
  readonly dealId: string;
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly reason: "invoice-fully-paid";
  readonly promptedAt: number;
}

export function buildWonPrompt(
  dealId: string,
  invoiceId: string,
  invoiceNumber: string,
  now: number = Date.now(),
): WonPrompt {
  return {
    dealId,
    invoiceId,
    invoiceNumber,
    reason: "invoice-fully-paid",
    promptedAt: now,
  };
}

/**
 * Check if a deal should be prompted to Won. Returns a WonPrompt if:
 *   - the deal has a linked invoice that is fully paid
 *   - the deal is NOT already in a terminal stage (Won/Lost)
 *
 * The caller (deal repository) checks this after a payment feedback
 * arrives. The prompt is a suggestion — the owner decides.
 */
export function shouldPromptWon(
  deal: Deal,
  linkedInvoices: ReadonlyArray<{ id: string; number: string; status: string }>,
): WonPrompt | null {
  // Already in a terminal stage — no prompt.
  if (deal.stageId === "won" || deal.stageId === "lost") {
    return null;
  }
  // Check if any linked invoice is fully paid.
  const paidInvoice = linkedInvoices.find((inv) => inv.status === "paid");
  if (!paidInvoice) {
    return null;
  }
  return buildWonPrompt(deal.id, paidInvoice.id, paidInvoice.number);
}

// ───────────────────────────────────────────────
// The loop — data flow diagram
// ───────────────────────────────────────────────

/**
 * The anchor thesis, made concrete:
 *
 *   customer → deal → invoice → paid
 *      ↓         ↓        ↓        ↓
 *   Customer   Deal    Invoice   MonetaryFact (invoice-paid)
 *      ↑         ↑        ↑        ↓
 *      └─────────┴────────┴── ActivityFact (invoice_paid on deal + customer)
 *
 * The CRM feeds the invoice (convertDealToInvoice). The money facts
 * flow back to the CRM (payment feedback → activity on deal). The
 * owner's mental model is literally the data flow.
 *
 * No separate "revenue from CRM" report needed — it's the same
 * fact table (money_facts) filtered by `sourceId IN (deal's invoices)`.
 * The pipeline totals (computePipelineTotals) + the customer's
 * timeline (buildTimeline) both read from the same facts.
 */

// ───────────────────────────────────────────────
// Convert repository contract
// ───────────────────────────────────────────────

export interface ConvertRepository {
  /**
   * Convert a deal to an invoice draft. Creates the invoice (via
   * invoicing's createDraft) + writes the dealInvoiceLink + writes
   * a deal_converted activity fact, all in one DB transaction.
   */
  convert(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    input: ConvertDealInput,
    invoiceId: string,
    actor: string,
  ): Promise<ConvertResult>;

  /**
   * Receive a payment feedback (from the invoicing pass). Writes an
   * invoice_paid activity fact on the deal + checks shouldPromptWon.
   * Returns a WonPrompt if the deal should be prompted to Won.
   */
  receivePaymentFeedback(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    feedback: PaymentFeedback,
  ): Promise<{ wonPrompt: WonPrompt | null }>;

  /**
   * Accept the Won prompt — moves the deal to Won (via moveStage).
   * Writes a deal_stage activity fact (stage move) in the same tx.
   */
  acceptWonPrompt(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    dealId: string,
  ): Promise<Deal>;

  /**
   * Dismiss the Won prompt — the deal stays in its current stage.
   * Writes a deal_stage activity fact recording the dismissal (for
   * analytics — "how often do owners accept vs dismiss?").
   */
  dismissWonPrompt(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    dealId: string,
    invoiceId: string,
  ): Promise<void>;
}
