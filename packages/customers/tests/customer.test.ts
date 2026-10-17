/**
 * Customer record tests.
 *
 * Covers:
 *   - record shape is deliberately small (no derived fields)
 *   - createCustomer normalizes tags/groups
 *   - updateContactInfo (immutable, normalizes)
 *   - status transitions (active ⇄ inactive → archived → active)
 *   - soft archive never deletes (archivedAt set/cleared)
 *   - invalid transitions throw
 *   - currency is a preference (can change without affecting facts)
 */

import { describe, it, expect } from "vitest";
import {
  createCustomer,
  updateContactInfo,
  transitionStatus,
  canTransitionStatus,
  InvalidCustomerTransitionError,
  type CreateCustomerInput,
} from "../src/customer.js";
import type { WorkspaceId } from "@supa/workspace-core/workspace";
import { asCurrency } from "@supa/money/money";

const WS = "00000000-0000-0000-0000-000000000001" as WorkspaceId;
const NOW = 1_700_000_000_000;

function makeInput(overrides?: Partial<CreateCustomerInput>): CreateCustomerInput {
  return {
    id: "cust-1",
    wsId: WS,
    name: "Musa Ibrahim",
    businessName: null,
    emails: [{ address: "musa@example.com", kind: "primary", verified: false }],
    phones: [{ number: "+2348012345678", kind: "mobile", primary: true }],
    addresses: [],
    currency: asCurrency("NGN"),
    taxId: null,
    tags: ["VIP", "wholesale"],
    groups: ["Lagos"],
    notes: "",
    createdBy: "user-1",
    ...overrides,
  };
}

describe("createCustomer", () => {
  it("creates an active customer with normalized tags/groups", () => {
    const c = createCustomer(makeInput({ tags: ["VIP", "vip", "  Wholesale  "], groups: ["  Lagos  "] }), NOW);
    expect(c.status).toBe("active");
    expect(c.tags).toEqual(["vip", "wholesale"]); // deduped + lowercased + trimmed
    expect(c.groups).toEqual(["lagos"]);
  });

  it("trims name + businessName", () => {
    const c = createCustomer(makeInput({ name: "  Musa  ", businessName: "  Ibrahim & Sons  " }), NOW);
    expect(c.name).toBe("Musa");
    expect(c.businessName).toBe("Ibrahim & Sons");
  });

  it("nulls out empty businessName/taxId", () => {
    const c = createCustomer(makeInput({ businessName: "   ", taxId: "  " }), NOW);
    expect(c.businessName).toBeNull();
    expect(c.taxId).toBeNull();
  });

  it("sets createdAt + updatedAt", () => {
    const c = createCustomer(makeInput(), NOW);
    expect(c.createdAt).toBe(NOW);
    expect(c.updatedAt).toBe(NOW);
    expect(c.archivedAt).toBeNull();
  });
});

describe("record shape — deliberately small", () => {
  it("has NO derived fields (LTV/balance/lastInvoice are queries)", () => {
    const c = createCustomer(makeInput(), NOW);
    // These fields must NOT exist on the Customer record.
    expect((c as any).lifetimeValue).toBeUndefined();
    expect((c as any).lastInvoiceDate).toBeUndefined();
    expect((c as any).outstandingBalance).toBeUndefined();
    expect((c as any).firstContact).toBeUndefined();
    expect((c as any).dealCount).toBeUndefined();
  });

  it("has identity + contact info + preferences + tags", () => {
    const c = createCustomer(makeInput(), NOW);
    expect(c.id).toBe("cust-1");
    expect(c.wsId).toBe(WS);
    expect(c.name).toBe("Musa Ibrahim");
    expect(c.emails).toHaveLength(1);
    expect(c.phones).toHaveLength(1);
    expect(c.currency).toBe("NGN");
    expect(c.tags).toEqual(["vip", "wholesale"]);
  });
});

describe("updateContactInfo", () => {
  it("returns a new customer (immutable)", () => {
    const original = createCustomer(makeInput(), NOW);
    const updated = updateContactInfo(original, { name: "New Name" }, NOW + 1000);
    expect(original.name).toBe("Musa Ibrahim"); // unchanged
    expect(updated.name).toBe("New Name");
    expect(updated.updatedAt).toBe(NOW + 1000);
  });

  it("normalizes tags/groups on update", () => {
    const original = createCustomer(makeInput(), NOW);
    const updated = updateContactInfo(original, { tags: ["NEW", "new", "VIP"] }, NOW + 1000);
    expect(updated.tags).toEqual(["new", "vip"]); // deduped + lowercased
  });

  it("does not change status via contact-info update", () => {
    const original = createCustomer(makeInput(), NOW);
    const updated = updateContactInfo(original, { name: "X" }, NOW + 1000);
    expect(updated.status).toBe(original.status);
    expect(updated.archivedAt).toBeNull();
  });
});

describe("status transitions", () => {
  it("active → inactive is allowed", () => {
    expect(canTransitionStatus("active", "inactive")).toBe(true);
  });

  it("active → archived is allowed (soft archive)", () => {
    expect(canTransitionStatus("active", "archived")).toBe(true);
  });

  it("archived → active is allowed (un-archive)", () => {
    expect(canTransitionStatus("archived", "active")).toBe(true);
  });

  it("inactive → archived is allowed", () => {
    expect(canTransitionStatus("inactive", "archived")).toBe(true);
  });

  it("archived → inactive is NOT allowed (must go through active)", () => {
    expect(canTransitionStatus("archived", "inactive")).toBe(false);
  });

  it("transitionStatus sets archivedAt on archive", () => {
    const c = createCustomer(makeInput(), NOW);
    const archived = transitionStatus(c, "archived", NOW + 1000);
    expect(archived.status).toBe("archived");
    expect(archived.archivedAt).toBe(NOW + 1000);
  });

  it("transitionStatus clears archivedAt on un-archive", () => {
    const c = createCustomer(makeInput(), NOW);
    const archived = transitionStatus(c, "archived", NOW + 1000);
    const unarchived = transitionStatus(archived, "active", NOW + 2000);
    expect(unarchived.status).toBe("active");
    expect(unarchived.archivedAt).toBeNull();
  });

  it("throws on invalid transition", () => {
    const c = createCustomer(makeInput(), NOW);
    const archived = transitionStatus(c, "archived", NOW);
    expect(() => transitionStatus(archived, "inactive", NOW)).toThrow(InvalidCustomerTransitionError);
  });
});

describe("soft archive — never delete", () => {
  it("archived customer retains all facts (the record is preserved)", () => {
    const c = createCustomer(makeInput(), NOW);
    const archived = transitionStatus(c, "archived", NOW + 1000);
    // The archived customer is the same record — just status + archivedAt changed.
    expect(archived.id).toBe(c.id);
    expect(archived.name).toBe(c.name);
    expect(archived.emails).toBe(c.emails);
    expect(archived.phones).toBe(c.phones);
    expect(archived.tags).toBe(c.tags);
  });

  it("currency is a preference — can change without affecting facts", () => {
    const c = createCustomer(makeInput(), NOW);
    expect(c.currency).toBe("NGN");
    // The customer's currency is just a default for new invoices.
    // Historical invoices carry their own currency on the MonetaryFact;
    // changing this preference doesn't rewrite history.
    const updated = updateContactInfo(c, { currency: asCurrency("USD") }, NOW + 1000);
    expect(updated.currency).toBe("USD");
    expect(c.currency).toBe("NGN"); // original unchanged (immutable)
  });
});
