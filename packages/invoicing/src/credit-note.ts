/**
 * @supa/invoicing/credit-note
 * ----------------------------------------------------------------
 * Credit notes get their own sequence (CN-...). The invoice counter
 * never decreases — credit notes are a separate document kind that
 * OFFSETS an invoice, not a decrement of the invoice number.
 *
 * A cancelled invoice is voided (terminal, keeps its number); the
 * void CREATES a credit note in the CN- sequence. The two sequences
 * are independent: a voided INV-0042 produces a CN-0001 (or whatever
 * the next CN number is), not "INV-0042-void".
 *
 * Auditability: money documents never vanish, they acquire a status.
 * Credit notes are the audit trail for refunds + voids.
 * ----------------------------------------------------------------
 */

import type { Money } from "@supa/money/money";
import type { WorkspaceId } from "@supa/workspace-core/workspace";
import type { Invoice } from "./invoice.js";

// ───────────────────────────────────────────────
// Credit note entity
// ───────────────────────────────────────────────

export interface CreditNote {
  readonly id: string;
  /** CN-0001 — allocated from the credit-note sequence (separate from invoice). */
  readonly number: string;
  readonly wsId: WorkspaceId;
  readonly profileId: string;
  /** The invoice this credit note offsets (always references a voided or paid invoice). */
  readonly invoiceId: string;
  /** The amount credited (in the invoice's currency). */
  readonly amount: Money;
  /** Why the credit note was issued (void, refund, adjustment). */
  readonly reason: CreditNoteReason;
  readonly createdAt: number;
}

export type CreditNoteReason =
  | "invoice-voided"      // the referenced invoice was voided
  | "refund-issued"       // a payment was refunded
  | "adjustment"          // a manual adjustment (e.g. bad debt write-off)
  | "partial-refund";     // a partial refund of a paid invoice

// ───────────────────────────────────────────────
// Credit note creation — separate sequence
// ───────────────────────────────────────────────

export interface CreateCreditNoteInput {
  readonly id: string;
  readonly wsId: WorkspaceId;
  readonly profileId: string;
  readonly invoiceId: string;
  readonly amount: Money;
  readonly reason: CreditNoteReason;
}

/**
 * Create a credit note. The number is allocated from the CN- sequence
 * (separate from the invoice sequence) — the caller passes the
 * already-allocated number; the repository layer is responsible for
 * calling allocator.allocate({ ..., kind: "credit-note" }) inside
 * the same DB transaction as the credit note insert.
 *
 * The credit note NEVER touches the invoice counter. The invoice's
 * number stays as-is (voided invoices keep their number). The
 * credit note's number is independent (CN-0001, CN-0002, ...).
 *
 * Counter never decreases — credit notes are additive, not
 * decremental. A voided INV-0042 + CN-0001 is the audit trail; the
 * report query sums them: revenue = Σ(invoices) − Σ(credit-notes).
 */
export function createCreditNote(
  input: CreateCreditNoteInput,
  allocatedNumber: string,
  now: number = Date.now(),
): CreditNote {
  return {
    id: input.id,
    number: allocatedNumber,
    wsId: input.wsId,
    profileId: input.profileId,
    invoiceId: input.invoiceId,
    amount: input.amount,
    reason: input.reason,
    createdAt: now,
  };
}

// ───────────────────────────────────────────────
// Void → credit note — the canonical flow
// ───────────────────────────────────────────────

/**
 * The canonical void flow:
 *   1. invoice.void() → invoice status = "voided" (keeps its number)
 *   2. createCreditNote() with reason="invoice-voided" → CN-XXXX
 *
 * These happen in the same DB transaction (the repository layer is
 * responsible for the transaction boundary). The invoice counter is
 * NOT touched — only the credit-note counter is incremented.
 *
 * If the void succeeds but the credit note creation fails, the
 * transaction rolls back — the invoice stays in its pre-void status.
 * This is the "money documents never vanish" rule: a void that
 * doesn't create an audit trail didn't happen.
 */
export interface VoidWithCreditNoteResult {
  readonly invoice: Invoice;
  readonly creditNote: CreditNote;
}

// ───────────────────────────────────────────────
// Credit note repository contract
// ───────────────────────────────────────────────

export interface CreditNoteRepository {
  /** Create a credit note (allocates from CN- sequence atomically). */
  create(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    input: CreateCreditNoteInput,
    allocator: import("./numbering.js").NumberAllocator,
  ): Promise<CreditNote>;

  /** Get a credit note by id (scoped by wsId). */
  findById(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    id: string,
  ): Promise<CreditNote | null>;

  /** List credit notes for an invoice (the audit trail for a void/refund). */
  listByInvoice(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    invoiceId: string,
  ): Promise<CreditNote[]>;

  /** List credit notes for a profile. */
  listByProfile(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    profileId: string,
  ): Promise<CreditNote[]>;
}

// ───────────────────────────────────────────────
// Net revenue calculation — invoices minus credit notes
// ───────────────────────────────────────────────

/**
 * Compute net revenue = Σ(invoice totals) − Σ(credit note amounts),
 * for a given currency. The report query (from @supa/money/currency)
 * handles conversion to base; this function does the arithmetic in
 * the native currency.
 *
 * This is the "money documents never vanish" payoff: every credit
 * note is a positive entry in the CN- sequence; net revenue is the
 * difference. No silent mutations, no deleted rows — just addition
 * and subtraction of immutable facts.
 */
export function computeNetRevenue(
  invoices: ReadonlyArray<{ totals: { total: Money } }>,
  creditNotes: ReadonlyArray<CreditNote>,
  defaultCurrency: string = "NGN",
): Money {
  if (invoices.length === 0 && creditNotes.length === 0) {
    // No inputs to infer a currency from — fall back to the caller's
    // default (Net 30 / NGN by convention). The caller now passes this
    // explicitly so the empty case isn't silently pinned to NGN.
    const { zero } = require("@supa/money/money") as typeof import("@supa/money/money");
    return zero(defaultCurrency);
  }
  // If we have credit notes but no invoices, infer the currency from
  // the first credit note (previously this branch crashed because it
  // tried to read invoices[0]!.totals.total).
  if (invoices.length === 0) {
    const { zero, subtract } = require("@supa/money/money") as typeof import("@supa/money/money");
    let total = zero(creditNotes[0]!.amount.currency);
    for (const cn of creditNotes) {
      total = subtract(total, cn.amount);
    }
    return total;
  }
  const { add, subtract } = require("@supa/money/money") as typeof import("@supa/money/money");
  // Start from the first invoice's total.
  let total = invoices[0]!.totals.total;
  for (let i = 1; i < invoices.length; i++) {
    total = add(total, invoices[i]!.totals.total);
  }
  for (const cn of creditNotes) {
    total = subtract(total, cn.amount);
  }
  return total;
}
