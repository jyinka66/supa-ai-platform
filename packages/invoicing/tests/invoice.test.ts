/**
 * Invoice lifecycle tests.
 *
 * Covers:
 *   - draft creation (no number allocated)
 *   - draft → issued (number allocated, dueAt computed)
 *   - issued → partial → paid (payment flow)
 *   - issued → voided (terminal, keeps number)
 *   - paid → voided (refund flow)
 *   - voided is terminal (no transitions out)
 *   - invalid transitions throw
 *   - voided invoice keeps its number (auditability)
 */

import { describe, it, expect } from "vitest";
import {
  createDraft,
  issue,
  applyPayment,
  markPaid,
  void_,
  canTransition,
  InvalidTransitionError,
  type CreateInvoiceInput,
} from "../src/invoice.js";
import { money, fromMinor, type Money } from "@supa/money/money";
import type { WorkspaceId } from "@supa/workspace-core/workspace";

// ───────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────

const WS = "00000000-0000-0000-0000-000000000001" as WorkspaceId;
const PROFILE = "p1";
const NOW = 1_700_000_000_000;

function makeInput(overrides?: Partial<CreateInvoiceInput>): CreateInvoiceInput {
  const net = money("100.00", "NGN");
  return {
    id: "inv-1",
    wsId: WS,
    profileId: PROFILE,
    lineItems: [
      { description: "Design work", net, quantity: 1n },
    ],
    taxMode: "per-line",
    currency: "NGN",
    dueInDays: 30,
    ...overrides,
  };
}

// ───────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────

describe("createDraft", () => {
  it("creates a draft with no number allocated", () => {
    const inv = createDraft(makeInput(), NOW);
    expect(inv.status).toBe("draft");
    expect(inv.number).toBeNull();
    expect(inv.issuedAt).toBeNull();
    expect(inv.dueAt).toBeNull();
    expect(inv.createdAt).toBe(NOW);
    expect(inv.updatedAt).toBe(NOW);
  });

  it("computes totals at creation (so user can preview)", () => {
    const inv = createDraft(makeInput(), NOW);
    expect(inv.totals.subtotal.minor).toBe(10_000n); // 100.00 NGN = 10000 kobo
    expect(inv.totals.total.minor).toBe(10_000n); // no tax rate → tax=0
  });

  it("carries wsId + profileId (tenancy spine)", () => {
    const inv = createDraft(makeInput(), NOW);
    expect(inv.wsId).toBe(WS);
    expect(inv.profileId).toBe(PROFILE);
  });
});

describe("issue (draft → issued)", () => {
  it("allocates the number at issue", () => {
    const draft = createDraft(makeInput(), NOW);
    const issued = issue(draft, "INV-0001", NOW + 1000);
    expect(issued.status).toBe("issued");
    expect(issued.number).toBe("INV-0001");
    expect(issued.issuedAt).toBe(NOW + 1000);
  });

  it("computes dueAt from issue date + dueInDays", () => {
    const draft = createDraft(makeInput(), NOW);
    const issued = issue(draft, "INV-0001", NOW);
    // dueInDays=30 → dueAt = NOW + 30 days
    expect(issued.dueAt).toBe(NOW + 30 * 86_400_000);
  });

  it("throws on invalid transition (issued → issued)", () => {
    const draft = createDraft(makeInput(), NOW);
    const issued = issue(draft, "INV-0001", NOW);
    expect(() => issue(issued, "INV-0002", NOW)).toThrow(InvalidTransitionError);
  });

  it("throws on invalid transition (voided → issued)", () => {
    const draft = createDraft(makeInput(), NOW);
    const issued = issue(draft, "INV-0001", NOW);
    const voided = void_(issued, NOW);
    expect(() => issue(voided, "INV-0002", NOW)).toThrow(InvalidTransitionError);
  });
});

describe("applyPayment (issued → partial)", () => {
  it("transitions issued → partial on first payment", () => {
    const draft = createDraft(makeInput(), NOW);
    const issued = issue(draft, "INV-0001", NOW);
    const payment = fromMinor(5_000n, "NGN");
    const partial = applyPayment(issued, payment, NOW + 1000);
    expect(partial.status).toBe("partial");
  });

  it("throws on invalid transition (draft → partial)", () => {
    const draft = createDraft(makeInput(), NOW);
    const payment = fromMinor(5_000n, "NGN");
    expect(() => applyPayment(draft, payment, NOW)).toThrow(InvalidTransitionError);
  });
});

describe("markPaid", () => {
  it("transitions partial → paid", () => {
    const draft = createDraft(makeInput(), NOW);
    const issued = issue(draft, "INV-0001", NOW);
    const partial = applyPayment(issued, fromMinor(5_000n, "NGN"), NOW);
    const paid = markPaid(partial, NOW);
    expect(paid.status).toBe("paid");
  });

  it("transitions issued → paid (full payment at once)", () => {
    const draft = createDraft(makeInput(), NOW);
    const issued = issue(draft, "INV-0001", NOW);
    const paid = markPaid(issued, NOW);
    expect(paid.status).toBe("paid");
  });

  it("throws on invalid transition (draft → paid)", () => {
    const draft = createDraft(makeInput(), NOW);
    expect(() => markPaid(draft, NOW)).toThrow(InvalidTransitionError);
  });
});

describe("void_ (cancel — terminal, keeps number)", () => {
  it("transitions draft → voided (no number was allocated)", () => {
    const draft = createDraft(makeInput(), NOW);
    const voided = void_(draft, NOW);
    expect(voided.status).toBe("voided");
    expect(voided.number).toBeNull(); // never had a number
    expect(voided.voidedAt).toBe(NOW);
  });

  it("transitions issued → voided (keeps the allocated number)", () => {
    const draft = createDraft(makeInput(), NOW);
    const issued = issue(draft, "INV-0001", NOW);
    const voided = void_(issued, NOW);
    expect(voided.status).toBe("voided");
    expect(voided.number).toBe("INV-0001"); // KEPT — auditability
    expect(voided.voidedAt).toBe(NOW);
  });

  it("transitions paid → voided (refund flow)", () => {
    const draft = createDraft(makeInput(), NOW);
    const issued = issue(draft, "INV-0001", NOW);
    const paid = markPaid(issued, NOW);
    const voided = void_(paid, NOW);
    expect(voided.status).toBe("voided");
    expect(voided.number).toBe("INV-0001"); // still kept
  });

  it("voided is terminal — no transitions out", () => {
    const draft = createDraft(makeInput(), NOW);
    const voided = void_(draft, NOW);
    expect(() => issue(voided, "INV-0001", NOW)).toThrow(InvalidTransitionError);
    expect(() => applyPayment(voided, fromMinor(5_000n, "NGN"), NOW)).toThrow(InvalidTransitionError);
    expect(() => markPaid(voided, NOW)).toThrow(InvalidTransitionError);
    expect(() => void_(voided, NOW)).toThrow(InvalidTransitionError);
  });
});

describe("canTransition — the transition matrix", () => {
  it("draft can transition to issued or voided", () => {
    expect(canTransition("draft", "issued")).toBe(true);
    expect(canTransition("draft", "voided")).toBe(true);
    expect(canTransition("draft", "partial")).toBe(false);
    expect(canTransition("draft", "paid")).toBe(false);
  });

  it("issued can transition to partial, paid, or voided", () => {
    expect(canTransition("issued", "partial")).toBe(true);
    expect(canTransition("issued", "paid")).toBe(true);
    expect(canTransition("issued", "voided")).toBe(true);
    expect(canTransition("issued", "draft")).toBe(false); // no going back
  });

  it("partial can transition to paid or voided", () => {
    expect(canTransition("partial", "paid")).toBe(true);
    expect(canTransition("partial", "voided")).toBe(true);
    expect(canTransition("partial", "issued")).toBe(false);
  });

  it("paid can transition to voided only", () => {
    expect(canTransition("paid", "voided")).toBe(true);
    expect(canTransition("paid", "issued")).toBe(false);
    expect(canTransition("paid", "partial")).toBe(false);
  });

  it("voided is terminal — no transitions out", () => {
    expect(canTransition("voided", "draft")).toBe(false);
    expect(canTransition("voided", "issued")).toBe(false);
    expect(canTransition("voided", "partial")).toBe(false);
    expect(canTransition("voided", "paid")).toBe(false);
    expect(canTransition("voided", "voided")).toBe(false);
  });
});

describe("auditability — money documents never vanish", () => {
  it("a voided invoice keeps its number (audit trail)", () => {
    const draft = createDraft(makeInput(), NOW);
    const issued = issue(draft, "INV-0042", NOW);
    const voided = void_(issued, NOW);
    // The voided invoice is still in the system, with its number,
    // its totals, its issue date — only the status changed.
    expect(voided.number).toBe("INV-0042");
    expect(voided.issuedAt).toBe(NOW);
    expect(voided.totals.total.minor).toBe(10_000n);
    expect(voided.status).toBe("voided");
    expect(voided.voidedAt).toBe(NOW);
  });

  it("a draft that was never issued has no number (cost nothing)", () => {
    const draft = createDraft(makeInput(), NOW);
    const voided = void_(draft, NOW);
    expect(voided.number).toBeNull();
    // No number was allocated — abandoned drafts cost nothing.
  });
});
