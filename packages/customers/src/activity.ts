/**
 * @supa/customers/activity
 * ----------------------------------------------------------------
 * activity_facts: { id, wsId, customerId?, dealId?, kind:
 *   'note'|'call'|'meeting'|'email'|'invoice_sent'|
 *   'invoice_viewed'|'invoice_paid'|'payment'|'refund'|
 *   'deal_created'|'deal_stage'|'task'|'file', refId?,
 *   content?, occurredAt, actor, source: 'manual'|'system'|'ai' }
 *
 * Append-only, same discipline as money_facts. The magic of the
 *   timeline: invoice and payment events arrive here AUTOMATICALLY
 *   — the invoicing pass's fact writes fan out an activity fact.
 *   The shop owner opens a customer and sees: "Invoice INV-0042
 *   sent Tue · viewed Wed · paid Fri ₦45,000" without ever
 *   logging anything. Manual notes sit alongside. One timeline,
 *   two sources, zero double-entry.
 *
 * Editing rules: system facts are immutable (they mirror money
 *   facts); manual notes editable for 24h then frozen (edit vs
 *   audit honesty — after 24h, add a correction note, don't
 *   rewrite history).
 * ----------------------------------------------------------------
 */

import type { WorkspaceId } from "@supa/workspace-core/workspace";

// ───────────────────────────────────────────────
// Activity fact — append-only, two sources
// ───────────────────────────────────────────────

export type ActivityKind =
  | "note"             // manual note
  | "call"             // call logged
  | "meeting"          // meeting logged
  | "email"            // email sent/received
  | "invoice_sent"     // invoice issued (auto-fan-out from money_facts)
  | "invoice_viewed"   // invoice viewed by customer (auto)
  | "invoice_paid"     // invoice fully paid (auto)
  | "payment"          // payment received (auto)
  | "refund"           // refund issued (auto)
  | "deal_created"     // deal created (auto from deals pass)
  | "deal_stage"       // deal stage changed (auto)
  | "task"             // task created/completed
  | "file";            // file attached

export type ActivitySource = "manual" | "system" | "ai";

/**
 * A single activity fact. Append-only — same discipline as money_facts.
 *
 * System facts (source="system") are IMMUTABLE — they mirror money_facts.
 * Manual facts (source="manual") are editable for 24h, then frozen.
 * AI facts (source="ai") are immutable (they're system-generated).
 *
 * After 24h, add a correction note — don't rewrite history. Same
 * philosophy as invoice voids: relationships never vanish, they
 * acquire history.
 */
export interface ActivityFact {
  readonly id: string;
  readonly wsId: WorkspaceId;
  readonly customerId: string | null;
  readonly dealId: string | null;
  readonly kind: ActivityKind;
  /** Reference to the source object (e.g. invoice id for invoice_sent). */
  readonly refId: string | null;
  /** Content (note text, call summary, etc.). */
  readonly content: string | null;
  readonly occurredAt: number;
  /** Who triggered the activity (account id for manual; "system" for auto). */
  readonly actor: string;
  readonly source: ActivitySource;
  readonly createdAt: number;
  /** Edit window: manual notes editable for 24h. */
  readonly editedAt: number | null;
}

// ───────────────────────────────────────────────
// Fact construction — the single write path
// ───────────────────────────────────────────────

export interface CreateActivityInput {
  readonly id: string;
  readonly wsId: WorkspaceId;
  readonly customerId: string | null;
  readonly dealId: string | null;
  readonly kind: ActivityKind;
  readonly refId: string | null;
  readonly content: string | null;
  readonly occurredAt: number;
  readonly actor: string;
  readonly source: ActivitySource;
}

/**
 * THE single path by which activity facts are written.
 *
 * For system facts (invoice_sent, payment, refund, etc.), the
 * invoicing pass's fact writes call this function automatically —
 * the shop owner sees the activity without ever logging anything.
 *
 * For manual facts (notes, calls, meetings), the user-facing UI
 * calls this function. Manual facts get a 24h edit window; after
 * that, they're frozen (add a correction note instead).
 */
export function createActivity(input: CreateActivityInput, now: number = Date.now()): ActivityFact {
  // Validate source/kind consistency: system source only for system kinds.
  if (input.source === "system") {
    if (!SYSTEM_KINDS.has(input.kind)) {
      throw new ActivityKindError(
        `source="system" requires a system kind (invoice_sent, payment, etc.); got kind="${input.kind}"`,
      );
    }
  }
  return {
    id: input.id,
    wsId: input.wsId,
    customerId: input.customerId,
    dealId: input.dealId,
    kind: input.kind,
    refId: input.refId,
    content: input.content,
    occurredAt: input.occurredAt,
    actor: input.actor,
    source: input.source,
    createdAt: now,
    editedAt: null,
  };
}

export class ActivityKindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActivityKindError";
  }
}

// ───────────────────────────────────────────────
// System kinds — auto-fan-out from money_facts
// ───────────────────────────────────────────────

/**
 * Activity kinds that are auto-generated by the system (from
 * money_facts writes). These arrive on the timeline automatically —
 * the shop owner sees "Invoice INV-0042 sent" without ever logging
 * anything.
 *
 * The fan-out happens in the invoicing pass's repository: when an
 * invoice is issued (status: draft → issued), the repository writes
 * a MonetaryFact AND an ActivityFact(kind="invoice_sent") in the
 * same DB transaction. One timeline, two sources, zero double-entry.
 */
export const SYSTEM_KINDS: ReadonlySet<ActivityKind> = new Set([
  "invoice_sent",
  "invoice_viewed",
  "invoice_paid",
  "payment",
  "refund",
  "deal_created",
  "deal_stage",
]);

/**
 * Manual kinds — user-initiated. Editable for 24h, then frozen.
 */
export const MANUAL_KINDS: ReadonlySet<ActivityKind> = new Set([
  "note",
  "call",
  "meeting",
  "email",
  "task",
  "file",
]);

// ───────────────────────────────────────────────
// Edit window — 24h for manual notes, never for system
// ───────────────────────────────────────────────

const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Check if an activity fact is editable.
 *   - System facts: NEVER editable (immutable, mirror money_facts).
 *   - Manual facts: editable for 24h after creation, then frozen.
 *   - AI facts: never editable.
 */
export function isEditable(fact: ActivityFact, now: number = Date.now()): boolean {
  if (fact.source !== "manual") return false;
  return now - fact.createdAt <= EDIT_WINDOW_MS;
}

/**
 * Edit a manual activity fact's content. Throws if the fact is
 * not editable (system source, or past the 24h window).
 *
 * The edit sets `editedAt` — the original `content` is preserved
 * in the audit trail (the repository layer keeps a version history;
 * this function just updates the current content + marks the edit).
 */
export function editContent(
  fact: ActivityFact,
  newContent: string,
  now: number = Date.now(),
): ActivityFact {
  if (!isEditable(fact, now)) {
    if (fact.source !== "manual") {
      throw new ActivityEditError(
        `cannot edit ${fact.source} activity (only manual activities are editable)`,
      );
    }
    throw new ActivityEditError(
      `manual activity edit window expired (created ${new Date(fact.createdAt).toISOString()}, now ${new Date(now).toISOString()})`,
    );
  }
  return {
    ...fact,
    content: newContent,
    editedAt: now,
  };
}

export class ActivityEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActivityEditError";
  }
}

// ───────────────────────────────────────────────
// Auto-fan-out — invoicing pass calls these
// ───────────────────────────────────────────────

/**
 * Auto-fan-out from the invoicing pass. When an invoice is issued,
 * the repository calls this to write the corresponding activity
 * fact. The shop owner sees "Invoice INV-0042 sent" on the customer's
 * timeline without ever logging anything.
 *
 * These are SYSTEM facts — source="system", immutable.
 */
export function fanOutInvoiceSent(
  wsId: WorkspaceId,
  customerId: string,
  invoiceId: string,
  invoiceNumber: string,
  occurredAt: number,
): CreateActivityInput {
  return {
    id: `act-inv-sent-${invoiceId}`,
    wsId,
    customerId,
    dealId: null,
    kind: "invoice_sent",
    refId: invoiceId,
    content: `Invoice ${invoiceNumber} sent`,
    occurredAt,
    actor: "system",
    source: "system",
  };
}

export function fanOutInvoiceViewed(
  wsId: WorkspaceId,
  customerId: string,
  invoiceId: string,
  invoiceNumber: string,
  occurredAt: number,
): CreateActivityInput {
  return {
    id: `act-inv-viewed-${invoiceId}-${occurredAt}`,
    wsId,
    customerId,
    dealId: null,
    kind: "invoice_viewed",
    refId: invoiceId,
    content: `Invoice ${invoiceNumber} viewed`,
    occurredAt,
    actor: "system",
    source: "system",
  };
}

export function fanOutInvoicePaid(
  wsId: WorkspaceId,
  customerId: string,
  invoiceId: string,
  invoiceNumber: string,
  amountDisplay: string,
  occurredAt: number,
): CreateActivityInput {
  return {
    id: `act-inv-paid-${invoiceId}`,
    wsId,
    customerId,
    dealId: null,
    kind: "invoice_paid",
    refId: invoiceId,
    content: `Invoice ${invoiceNumber} paid (${amountDisplay})`,
    occurredAt,
    actor: "system",
    source: "system",
  };
}

export function fanOutPayment(
  wsId: WorkspaceId,
  customerId: string,
  invoiceId: string,
  amountDisplay: string,
  occurredAt: number,
): CreateActivityInput {
  return {
    id: `act-payment-${invoiceId}-${occurredAt}`,
    wsId,
    customerId,
    dealId: null,
    kind: "payment",
    refId: invoiceId,
    content: `Payment received (${amountDisplay})`,
    occurredAt,
    actor: "system",
    source: "system",
  };
}

export function fanOutRefund(
  wsId: WorkspaceId,
  customerId: string,
  invoiceId: string,
  amountDisplay: string,
  occurredAt: number,
): CreateActivityInput {
  return {
    id: `act-refund-${invoiceId}-${occurredAt}`,
    wsId,
    customerId,
    dealId: null,
    kind: "refund",
    refId: invoiceId,
    content: `Refund issued (${amountDisplay})`,
    occurredAt,
    actor: "system",
    source: "system",
  };
}

// ───────────────────────────────────────────────
// Timeline query — the customer's activity feed
// ───────────────────────────────────────────────

/**
 * Build the timeline for a customer. Mixes system facts (auto-fan-out
 * from money_facts) and manual facts (user-entered notes/calls/etc.)
 * into one chronological feed.
 *
 * The shop owner opens a customer and sees:
 *   "Invoice INV-0042 sent Tue · viewed Wed · paid Fri ₦45,000"
 *   "Note: prefers WhatsApp over email (Mon)"
 *   "Call: discussed Q2 retainer (last week)"
 *
 * One timeline, two sources, zero double-entry.
 */
export interface TimelineEntry {
  readonly fact: ActivityFact;
  /** Grouping bucket: "today" | "this-week" | "this-month" | "older". */
  readonly bucket: "today" | "this-week" | "this-month" | "older";
}

export function buildTimeline(
  facts: ReadonlyArray<ActivityFact>,
  now: number = Date.now(),
): TimelineEntry[] {
  const sorted = [...facts].sort((a, b) => b.occurredAt - a.occurredAt);
  const dayMs = 86_400_000;
  return sorted.map((fact) => {
    const ageDays = Math.floor((now - fact.occurredAt) / dayMs);
    const bucket: TimelineEntry["bucket"] =
      ageDays < 1 ? "today" :
      ageDays < 7 ? "this-week" :
      ageDays < 30 ? "this-month" :
      "older";
    return { fact, bucket };
  });
}

// ───────────────────────────────────────────────
// Activity repository contract
// ───────────────────────────────────────────────

export interface ActivityRepository {
  /** Write an activity fact (single path — manual or system). */
  create(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    input: CreateActivityInput,
  ): Promise<ActivityFact>;

  /** Edit a manual fact's content (within 24h window). */
  editContent(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    id: string,
    newContent: string,
  ): Promise<ActivityFact>;

  /** List activity facts for a customer (the timeline). */
  listByCustomer(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    customerId: string,
    filter?: { kinds?: readonly ActivityKind[]; limit?: number; before?: number },
  ): Promise<readonly ActivityFact[]>;

  /** List activity facts for a deal. */
  listByDeal(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    dealId: string,
  ): Promise<readonly ActivityFact[]>;

  /** Internal: repoint references after a merge. */
  repointReferences(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    fromCustomerId: string,
    toCustomerId: string,
  ): Promise<void>;
}
