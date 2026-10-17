/**
 * @supa/customers/customer
 * ----------------------------------------------------------------
 * Customer: { id, wsId, name, businessName?, emails[], phones[],
 *   addresses[], currency (default for invoices — a preference,
 *   not a fact), taxId?, tags[], groups[], notes (block, not
 *   scattered fields), status: 'active'|'inactive'|'archived',
 *   createdBy, createdAt }
 *
 * What's deliberately NOT here: lifetimeValue, lastInvoiceDate,
 *   outstandingBalance, firstContact. Those are QUERIES over
 *   money_facts + activity_facts. A stored LTV goes stale the
 *   moment someone backdates a payment; a computed one cannot.
 *   The five-minutes-to-learn constraint enforces itself here:
 *   a shop owner sees Name, phone, balance owed, last activity.
 *   Everything else is one tap deeper. Small surface, deep core.
 *
 * Soft archiving, never deletion: a customer referenced by an
 *   invoice is load-bearing — delete breaks the audit trail.
 *   Archive hides from lists, preserves every fact.
 * ----------------------------------------------------------------
 */

import type { WorkspaceId } from "@supa/workspace-core/workspace";
import type { Currency } from "@supa/money/money";

// ───────────────────────────────────────────────
// Customer status — soft archive, never delete
// ───────────────────────────────────────────────

export type CustomerStatus = "active" | "inactive" | "archived";

/**
 * Status transitions:
 *   active   ⇄ inactive  (temporarily paused — not hidden from lists)
 *   active   → archived  (hidden from lists, every fact preserved)
 *   archived → active    (un-archive — facts were never deleted)
 *
 * Archiving is soft: the customer is hidden from default list views,
 * but every invoice, activity, deal that references them is intact.
 * Delete is FORBIDDEN — a customer referenced by an invoice is
 * load-bearing; deleting breaks the audit trail. There is no
 * "delete" status, only "archived".
 */
const ALLOWED_STATUS_TRANSITIONS: Record<CustomerStatus, readonly CustomerStatus[]> = {
  active: ["inactive", "archived"],
  inactive: ["active", "archived"],
  archived: ["active"],
};

export function canTransitionStatus(from: CustomerStatus, to: CustomerStatus): boolean {
  return ALLOWED_STATUS_TRANSITIONS[from].includes(to);
}

// ───────────────────────────────────────────────
// Contact info — arrays, not scattered fields
// ───────────────────────────────────────────────

export interface Email {
  readonly address: string;
  /** "primary" | "billing" | "general" — the role this email plays. */
  readonly kind: "primary" | "billing" | "general";
  /** Whether this email has been verified. */
  readonly verified: boolean;
}

export interface Phone {
  /** E.164-ish normalized (e.g. "+2348012345678"). Stored normalized. */
  readonly number: string;
  readonly kind: "mobile" | "landline" | "whatsapp";
  readonly primary: boolean;
}

export interface Address {
  readonly line1: string;
  readonly line2: string | null;
  readonly city: string;
  readonly state: string | null;
  readonly postalCode: string | null;
  readonly country: string; // ISO 3166-1 alpha-2
  readonly kind: "billing" | "shipping" | "general";
}

// ───────────────────────────────────────────────
// Customer — the record, deliberately small
// ───────────────────────────────────────────────

/**
 * THE customer record. Identity + contact info + preferences + tags.
 *
 * What's NOT here (deliberately):
 *   - lifetimeValue        → query over money_facts (sum of paid invoices)
 *   - lastInvoiceDate      → query over money_facts (max asOf where kind=invoice-issued)
 *   - outstandingBalance   → query over money_facts (issued - paid)
 *   - firstContact         → query over activity_facts (min occurredAt)
 *   - dealCount            → query over deals (count by customerId)
 *
 * A stored LTV goes stale the moment someone backdates a payment;
 * a computed one cannot. This is the same discipline as the money
 * spine: a customer record is written once, never mutated except
 * for contact-info edits + status transitions. Everything derived
 * is a query.
 */
export interface Customer {
  readonly id: string;
  readonly wsId: WorkspaceId;
  /** Display name (e.g. "Musa Ibrahim"). */
  readonly name: string;
  /** Optional business name (e.g. "Ibrahim & Sons Ltd"). */
  readonly businessName: string | null;
  readonly emails: readonly Email[];
  readonly phones: readonly Phone[];
  readonly addresses: readonly Address[];
  /**
   * Default currency for invoices issued to this customer. A
   * PREFERENCE, not a fact — the customer's currency can change
   * without affecting historical invoices (which carry their own
   * currency on the MonetaryFact).
   */
  readonly currency: Currency;
  /** Tax ID (e.g. VAT registration number, TIN). */
  readonly taxId: string | null;
  /** Free-form tags (lowercased, trimmed). */
  readonly tags: readonly string[];
  /** Group memberships (e.g. "wholesale", "retail"). */
  readonly groups: readonly string[];
  /** Notes block — a single rich-text field, not scattered note fields. */
  readonly notes: string;
  readonly status: CustomerStatus;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Soft-archive timestamp (null = active/inactive). */
  readonly archivedAt: number | null;
}

// ───────────────────────────────────────────────
// Creation + updates — immutable transitions
// ───────────────────────────────────────────────

export interface CreateCustomerInput {
  readonly id: string;
  readonly wsId: WorkspaceId;
  readonly name: string;
  readonly businessName: string | null;
  readonly emails: readonly Email[];
  readonly phones: readonly Phone[];
  readonly addresses: readonly Address[];
  readonly currency: Currency;
  readonly taxId: string | null;
  readonly tags: readonly string[];
  readonly groups: readonly string[];
  readonly notes: string;
  readonly createdBy: string;
}

export function createCustomer(input: CreateCustomerInput, now: number = Date.now()): Customer {
  // Normalize tags (lowercase + trim) at creation.
  const tags = [...new Set(input.tags.map((t) => t.toLowerCase().trim()).filter(Boolean))];
  const groups = [...new Set(input.groups.map((g) => g.toLowerCase().trim()).filter(Boolean))];
  return {
    id: input.id,
    wsId: input.wsId,
    name: input.name.trim(),
    businessName: input.businessName?.trim() || null,
    emails: input.emails,
    phones: input.phones,
    addresses: input.addresses,
    currency: input.currency,
    taxId: input.taxId?.trim() || null,
    tags,
    groups,
    notes: input.notes,
    status: "active",
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
}

/**
 * Update contact info on a customer. Returns a new Customer (immutable).
 * Cannot change status via this — use transitionStatus().
 */
export function updateContactInfo(
  customer: Customer,
  changes: Partial<Pick<Customer, "name" | "businessName" | "emails" | "phones" | "addresses" | "taxId" | "tags" | "groups" | "notes" | "currency">>,
  now: number = Date.now(),
): Customer {
  // Normalize tags/groups if present in changes.
  const tags = changes.tags
    ? [...new Set(changes.tags.map((t) => t.toLowerCase().trim()).filter(Boolean))]
    : customer.tags;
  const groups = changes.groups
    ? [...new Set(changes.groups.map((g) => g.toLowerCase().trim()).filter(Boolean))]
    : customer.groups;
  return {
    ...customer,
    ...(changes.name !== undefined ? { name: changes.name.trim() } : {}),
    ...(changes.businessName !== undefined ? { businessName: changes.businessName?.trim() || null } : {}),
    ...(changes.emails !== undefined ? { emails: changes.emails } : {}),
    ...(changes.phones !== undefined ? { phones: changes.phones } : {}),
    ...(changes.addresses !== undefined ? { addresses: changes.addresses } : {}),
    ...(changes.taxId !== undefined ? { taxId: changes.taxId?.trim() || null } : {}),
    ...(changes.currency !== undefined ? { currency: changes.currency } : {}),
    tags,
    groups,
    ...(changes.notes !== undefined ? { notes: changes.notes } : {}),
    updatedAt: now,
  };
}

/**
 * Transition the customer's status. Throws on invalid transition.
 * Archive sets archivedAt; un-archive clears it.
 */
export function transitionStatus(
  customer: Customer,
  to: CustomerStatus,
  now: number = Date.now(),
): Customer {
  if (!canTransitionStatus(customer.status, to)) {
    throw new InvalidCustomerTransitionError(customer.status, to);
  }
  return {
    ...customer,
    status: to,
    ...(to === "archived" ? { archivedAt: now } : {}),
    ...(to !== "archived" ? { archivedAt: null } : {}),
    updatedAt: now,
  };
}

export class InvalidCustomerTransitionError extends Error {
  constructor(
    readonly from: CustomerStatus,
    readonly to: CustomerStatus,
  ) {
    super(`invalid customer status transition: ${from} → ${to}`);
    this.name = "InvalidCustomerTransitionError";
  }
}

// ───────────────────────────────────────────────
// Customer repository contract
// ───────────────────────────────────────────────

/**
 * The customer repository. Every function takes a WorkspaceScope
 * (tenancy spine). Cross-tenant access is impossible — RLS + the
 * lint rule + the property test are the three gates.
 *
 * The repository NEVER computes derived fields. List queries return
 * the raw Customer record; the caller composes derived views (LTV,
 * balance, last activity) by joining with money_facts + activity_facts.
 */
export interface CustomerRepository {
  create(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    input: CreateCustomerInput,
  ): Promise<Customer>;

  findById(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    id: string,
  ): Promise<Customer | null>;

  /** List customers (excludes archived by default). */
  list(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    filter?: {
      status?: CustomerStatus;
      tags?: readonly string[];
      groups?: readonly string[];
      search?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<readonly Customer[]>;

  updateContactInfo(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    id: string,
    changes: Partial<Pick<Customer, "name" | "businessName" | "emails" | "phones" | "addresses" | "taxId" | "tags" | "groups" | "notes" | "currency">>,
  ): Promise<Customer>;

  transitionStatus(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    id: string,
    to: CustomerStatus,
  ): Promise<Customer>;

  /** Internal: repoint references after a merge (called by the merge transaction). */
  repointReferences(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    fromCustomerId: string,
    toCustomerId: string,
  ): Promise<void>;
}
