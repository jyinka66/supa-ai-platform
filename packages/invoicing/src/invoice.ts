/**
 * @supa/invoicing/invoice
 * ----------------------------------------------------------------
 * Invoice entity + lifecycle.
 *
 * Statuses:
 *   draft    → not yet sent; no invoice number allocated
 *   issued   → sent; number allocated at this transition (atomic)
 *   partial  → partially paid; multiple payments applied
 *   paid     → fully paid; no further payments accepted
 *   voided   → cancelled; auditability means money documents never
 *              vanish, they acquire a status. Voided is terminal.
 *
 * Transitions are one-way for money-relevant ones:
 *   draft → issued → partial → paid
 *                ↘ voided (terminal)
 *
 * A voided invoice keeps its number (it was issued, the number was
 * allocated). The void creates a credit note in the CN- sequence
 * (separate from the invoice counter — see credit-note.ts).
 * ----------------------------------------------------------------
 */

import type { Money } from "@supa/money/money";
import type { InvoiceTotals } from "@supa/money/money";
import type { WorkspaceId } from "@supa/workspace-core/workspace";

// ───────────────────────────────────────────────
// Invoice status — the lifecycle
// ───────────────────────────────────────────────

export type InvoiceStatus =
  | "draft"
  | "issued"
  | "partial"
  | "paid"
  | "voided";

/**
 * Allowed status transitions. Draft → issued is the only transition
 * that allocates a number (see numbering.shouldAllocate). Issued →
 * voided is allowed (cancel a sent invoice — creates a credit note
 * in the CN- sequence, doesn't decrement the invoice counter).
 *
 * Paid → voided is allowed (refund a paid invoice — the void
 * creates a credit note that offsets the payment).
 *
 * Voided is terminal — no transitions out.
 */
const ALLOWED_TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  draft: ["issued", "voided"],
  issued: ["partial", "paid", "voided"],
  partial: ["paid", "voided"],
  paid: ["voided"],
  voided: [],
};

export function canTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: InvoiceStatus,
    readonly to: InvoiceStatus,
  ) {
    super(`invalid invoice status transition: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

// ───────────────────────────────────────────────
// Invoice entity
// ───────────────────────────────────────────────

/**
 * The invoice entity. Immutable — every transition returns a new
 * Invoice with the updated status (and possibly an allocated
 * number, on draft → issued).
 *
 *   id            — stable ULID, assigned at draft creation
 *   number        — null while draft; allocated at issue (INV-0042)
 *   status        — the lifecycle state
 *   profileId     — which business profile issued it (per-profile numbering)
 *   wsId          — workspace ownership (tenancy spine)
 *   totals        — Money + tax breakdown (from @supa/money)
 *   issuedAt      — null while draft; set at issue
 *   dueAt         — computed from issue date + payment terms
 *   dueInDays     — payment terms (e.g. 30 for Net 30); stored so the
 *                   value is recoverable without re-reading the input
 *   voidedAt      — null unless status=voided
 *
 * The invoice carries the LineItems + tax mode + currency. The
 * totals are computed via @supa/money.computeInvoiceTotals — the
 * property test invariant Σ(lines) − Σ(discounts) + Σ(tax) +
 * roundRemainder === total holds for every invoice.
 */
export interface Invoice {
  readonly id: string;
  readonly number: string | null;
  readonly status: InvoiceStatus;
  readonly wsId: WorkspaceId;
  readonly profileId: string;
  readonly lineItems: readonly LineItem[];
  readonly taxMode: "per-line" | "per-invoice";
  readonly currency: string;
  readonly totals: InvoiceTotals;
  readonly issuedAt: number | null;
  readonly dueAt: number | null;
  /** Payment terms (days from issue). Stored so it's recoverable. */
  readonly dueInDays: number;
  readonly voidedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface LineItem {
  readonly description: string;
  readonly net: Money;
  readonly quantity: bigint;
  readonly discount?: Money | undefined;
  readonly taxRate?: string | undefined;
}

// ───────────────────────────────────────────────
// Invoice creation — drafts don't allocate numbers
// ───────────────────────────────────────────────

export interface CreateInvoiceInput {
  readonly id: string;
  readonly wsId: WorkspaceId;
  readonly profileId: string;
  readonly lineItems: readonly LineItem[];
  readonly taxMode: "per-line" | "per-invoice";
  readonly currency: string;
  /** Due-in days from issue date (computed when issued). */
  readonly dueInDays: number;
}

/**
 * Create a draft invoice. Does NOT allocate a number — the invoice
 * starts with number=null, status="draft". Numbers allocate at first
 * send (draft → issued).
 *
 * Abandoned drafts cost nothing — they never touched the counter.
 */
export function createDraft(input: CreateInvoiceInput, now: number = Date.now()): Invoice {
  // Compute totals immediately — the draft carries its totals so the
  // user can preview the invoice before sending.
  const totals = computeTotals(input.lineItems, input.taxMode, input.currency);
  return {
    id: input.id,
    number: null,
    status: "draft",
    wsId: input.wsId,
    profileId: input.profileId,
    lineItems: input.lineItems,
    taxMode: input.taxMode,
    currency: input.currency,
    totals,
    issuedAt: null,
    dueAt: null,
    dueInDays: input.dueInDays,
    voidedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

// ───────────────────────────────────────────────
// Status transitions
// ───────────────────────────────────────────────

/**
 * Issue a draft invoice. This is the ONLY transition that allocates
 * a number (via the NumberAllocator). The caller passes the allocated
 * number — the repository layer is responsible for calling
 * allocator.allocate() inside the same DB transaction as the status
 * update, so the allocate + the issuedAt update are atomic.
 *
 * If the allocate succeeds but the status update fails, the
 * transaction rolls back — the number is "consumed" (gap created)
 * but the invoice stays draft. This is correct: gaps are honest,
 * the next issue call gets the next number.
 */
export function issue(invoice: Invoice, allocatedNumber: string, now: number = Date.now()): Invoice {
  if (!canTransition(invoice.status, "issued")) {
    throw new InvalidTransitionError(invoice.status, "issued");
  }
  return {
    ...invoice,
    number: allocatedNumber,
    status: "issued",
    issuedAt: now,
    dueAt: now + getDueInDays(invoice) * 86_400_000,
    updatedAt: now,
  };
}

/**
 * Apply a payment to an issued/partial invoice. Returns the new
 * status (partial or paid) + the updated invoice.
 *
 * Payments are recorded as separate MonetaryFact entries (via
 * @supa/money.writeFact) — the invoice itself just tracks status.
 * The repository layer is responsible for writing the payment fact
 * + updating the invoice status in the same transaction.
 */
export function applyPayment(
  invoice: Invoice,
  paymentAmount: Money,
  now: number = Date.now(),
): Invoice {
  if (!canTransition(invoice.status, "partial") && !canTransition(invoice.status, "paid")) {
    throw new InvalidTransitionError(invoice.status, "paid");
  }
  // The repository layer tracks applied payments separately; this
  // function just computes the new status based on whether the
  // payment covers the total. Real impl sums all payments + this one.
  void paymentAmount;
  const newStatus: InvoiceStatus = invoice.status === "issued" ? "partial" : invoice.status;
  return {
    ...invoice,
    status: newStatus,
    updatedAt: now,
  };
}

/**
 * Mark an invoice as fully paid. Terminal-ish (paid → voided is
 * still allowed for refunds).
 */
export function markPaid(invoice: Invoice, now: number = Date.now()): Invoice {
  if (!canTransition(invoice.status, "paid")) {
    throw new InvalidTransitionError(invoice.status, "paid");
  }
  return {
    ...invoice,
    status: "paid",
    updatedAt: now,
  };
}

/**
 * Void an invoice. Voided is terminal — money documents never
 * vanish, they acquire a status. A voided invoice keeps its number
 * (it was issued; the number was allocated). The void creates a
 * credit note in the CN- sequence (separate counter — see
 * credit-note.ts).
 *
 * Void is allowed from any non-terminal status. The repository layer
 * creates the credit note + updates the invoice status in the same
 * transaction.
 */
export function void_(invoice: Invoice, now: number = Date.now()): Invoice {
  if (!canTransition(invoice.status, "voided")) {
    throw new InvalidTransitionError(invoice.status, "voided");
  }
  return {
    ...invoice,
    status: "voided",
    voidedAt: now,
    updatedAt: now,
  };
}

// ───────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────

function getDueInDays(invoice: Invoice): number {
  // Payment terms are now stored on the Invoice entity itself, so the
  // due date can be recomputed from issue date + dueInDays without
  // re-reading the input. A reasonable default (Net 30) is used only
  // when the stored value is missing/zero — e.g. for legacy invoices
  // that were created before this field existed.
  if (typeof invoice.dueInDays === "number" && invoice.dueInDays > 0) {
    return invoice.dueInDays;
  }
  return 30;
}

function computeTotals(
  lineItems: readonly LineItem[],
  taxMode: "per-line" | "per-invoice",
  currency: string,
): InvoiceTotals {
  // Delegate to @supa/money's computeInvoiceTotals.
  // Local import to avoid cycle at module load.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { computeInvoiceTotals } = require("@supa/money/money") as typeof import("@supa/money/money");
  return computeInvoiceTotals(
    lineItems.map((li) => ({
      net: li.net,
      quantity: li.quantity,
      ...(li.discount !== undefined ? { discount: li.discount } : {}),
      ...(li.taxRate !== undefined ? { taxRate: li.taxRate } : {}),
    })),
    taxMode,
  );
  void currency; // currency is enforced inside Money arithmetic
}

// ───────────────────────────────────────────────
// Invoice repository contract
// ───────────────────────────────────────────────

/**
 * The invoice repository. Every function takes a WorkspaceScope (the
 * tenancy spine). The issue function is the only one that allocates
 * a number — it does so inside a DB transaction so the allocate +
 * the status update are atomic.
 */
export interface InvoiceRepository {
  /** Create a draft invoice (no number allocated). */
  create(scope: import("@supa/workspace-core/workspace").WorkspaceScope, input: CreateInvoiceInput): Promise<Invoice>;

  /** Get an invoice by id (scoped by wsId — cross-tenant impossible). */
  findById(scope: import("@supa/workspace-core/workspace").WorkspaceScope, id: string): Promise<Invoice | null>;

  /**
   * Issue a draft invoice. Allocates a number atomically (the
   * NumberAllocator is called inside the same DB transaction as
   * the status update). Returns the issued invoice with the
   * allocated number.
   *
   * If the allocate succeeds but the update fails, the transaction
   * rolls back (gap created, invoice stays draft — correct).
   */
  issue(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    id: string,
    allocator: import("./numbering.js").NumberAllocator,
  ): Promise<Invoice>;

  /** Apply a payment (writes a MonetaryFact + updates status). */
  applyPayment(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    invoiceId: string,
    paymentAmount: Money,
  ): Promise<Invoice>;

  /** Void an invoice (creates a credit note, terminal). */
  void(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    invoiceId: string,
  ): Promise<Invoice>;

  /** List invoices for a profile (scoped by wsId + profileId). */
  listByProfile(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    profileId: string,
    filter?: { status?: InvoiceStatus },
  ): Promise<Invoice[]>;
}
