/**
 * Activity facts tests.
 *
 * Covers:
 *   - createActivity (system + manual sources)
 *   - system kinds are immutable (never editable)
 *   - manual notes editable for 24h, then frozen
 *   - auto-fan-out helpers produce correct system facts
 *   - timeline building (chronological + bucketing)
 *   - source/kind consistency validation
 */

import { describe, it, expect } from "vitest";
import {
  createActivity,
  isEditable,
  editContent,
  ActivityKindError,
  ActivityEditError,
  fanOutInvoiceSent,
  fanOutInvoicePaid,
  fanOutPayment,
  buildTimeline,
  SYSTEM_KINDS,
  MANUAL_KINDS,
  type CreateActivityInput,
} from "../src/activity.js";
import type { WorkspaceId } from "@supa/workspace-core/workspace";

const WS = "00000000-0000-0000-0000-000000000001" as WorkspaceId;
const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function makeInput(overrides?: Partial<CreateActivityInput>): CreateActivityInput {
  return {
    id: "act-1",
    wsId: WS,
    customerId: "cust-1",
    dealId: null,
    kind: "note",
    refId: null,
    content: "Discussed Q2 retainer",
    occurredAt: NOW,
    actor: "user-1",
    source: "manual",
    ...overrides,
  };
}

describe("createActivity", () => {
  it("creates a manual note activity", () => {
    const a = createActivity(makeInput(), NOW);
    expect(a.kind).toBe("note");
    expect(a.source).toBe("manual");
    expect(a.content).toBe("Discussed Q2 retainer");
    expect(a.createdAt).toBe(NOW);
    expect(a.editedAt).toBeNull();
  });

  it("creates a system activity (invoice_sent)", () => {
    const a = createActivity(
      makeInput({
        kind: "invoice_sent",
        source: "system",
        actor: "system",
        refId: "inv-1",
        content: "Invoice INV-0042 sent",
      }),
      NOW,
    );
    expect(a.kind).toBe("invoice_sent");
    expect(a.source).toBe("system");
  });

  it("rejects source=system with a manual kind", () => {
    expect(() =>
      createActivity(makeInput({ kind: "note", source: "system" }), NOW),
    ).toThrow(ActivityKindError);
  });

  it("allows source=manual with a manual kind", () => {
    const a = createActivity(makeInput({ kind: "call", source: "manual" }), NOW);
    expect(a.kind).toBe("call");
    expect(a.source).toBe("manual");
  });
});

describe("SYSTEM_KINDS vs MANUAL_KINDS", () => {
  it("system kinds are the auto-fan-out kinds", () => {
    expect(SYSTEM_KINDS.has("invoice_sent")).toBe(true);
    expect(SYSTEM_KINDS.has("invoice_viewed")).toBe(true);
    expect(SYSTEM_KINDS.has("invoice_paid")).toBe(true);
    expect(SYSTEM_KINDS.has("payment")).toBe(true);
    expect(SYSTEM_KINDS.has("refund")).toBe(true);
    expect(SYSTEM_KINDS.has("deal_created")).toBe(true);
    expect(SYSTEM_KINDS.has("deal_stage")).toBe(true);
  });

  it("manual kinds are the user-initiated kinds", () => {
    expect(MANUAL_KINDS.has("note")).toBe(true);
    expect(MANUAL_KINDS.has("call")).toBe(true);
    expect(MANUAL_KINDS.has("meeting")).toBe(true);
    expect(MANUAL_KINDS.has("email")).toBe(true);
    expect(MANUAL_KINDS.has("task")).toBe(true);
    expect(MANUAL_KINDS.has("file")).toBe(true);
  });

  it("no overlap between system and manual kinds", () => {
    for (const k of SYSTEM_KINDS) {
      expect(MANUAL_KINDS.has(k)).toBe(false);
    }
  });
});

describe("editability — 24h window for manual, never for system", () => {
  it("manual note is editable within 24h", () => {
    const a = createActivity(makeInput(), NOW);
    expect(isEditable(a, NOW + 1)).toBe(true);
    expect(isEditable(a, NOW + 23 * 60 * 60 * 1000)).toBe(true);
  });

  it("manual note is NOT editable after 24h", () => {
    const a = createActivity(makeInput(), NOW);
    expect(isEditable(a, NOW + 25 * 60 * 60 * 1000)).toBe(false);
  });

  it("system activity is NEVER editable", () => {
    const a = createActivity(
      makeInput({ kind: "invoice_sent", source: "system", actor: "system" }),
      NOW,
    );
    expect(isEditable(a, NOW + 1)).toBe(false);
    expect(isEditable(a, NOW + 100 * DAY)).toBe(false);
  });

  it("editContent works within 24h", () => {
    const a = createActivity(makeInput(), NOW);
    const edited = editContent(a, "Updated note", NOW + 1000);
    expect(edited.content).toBe("Updated note");
    expect(edited.editedAt).toBe(NOW + 1000);
  });

  it("editContent throws after 24h", () => {
    const a = createActivity(makeInput(), NOW);
    expect(() => editContent(a, "Late edit", NOW + 25 * 60 * 60 * 1000)).toThrow(ActivityEditError);
  });

  it("editContent throws for system activities", () => {
    const a = createActivity(
      makeInput({ kind: "invoice_sent", source: "system", actor: "system" }),
      NOW,
    );
    expect(() => editContent(a, "Hack", NOW + 1)).toThrow(ActivityEditError);
  });
});

describe("auto-fan-out — invoice/payment events arrive automatically", () => {
  it("fanOutInvoiceSent produces the correct system fact", () => {
    const input = fanOutInvoiceSent(WS, "cust-1", "inv-1", "INV-0042", NOW);
    expect(input.kind).toBe("invoice_sent");
    expect(input.source).toBe("system");
    expect(input.actor).toBe("system");
    expect(input.customerId).toBe("cust-1");
    expect(input.refId).toBe("inv-1");
    expect(input.content).toContain("INV-0042");
    expect(input.content).toContain("sent");
  });

  it("fanOutInvoicePaid produces the correct system fact", () => {
    const input = fanOutInvoicePaid(WS, "cust-1", "inv-1", "INV-0042", "₦45,000", NOW);
    expect(input.kind).toBe("invoice_paid");
    expect(input.source).toBe("system");
    expect(input.content).toContain("INV-0042");
    expect(input.content).toContain("₦45,000");
    expect(input.content).toContain("paid");
  });

  it("fanOutPayment produces the correct system fact", () => {
    const input = fanOutPayment(WS, "cust-1", "inv-1", "₦45,000", NOW);
    expect(input.kind).toBe("payment");
    expect(input.source).toBe("system");
    expect(input.content).toContain("Payment received");
    expect(input.content).toContain("₦45,000");
  });

  it("fan-out facts are createable via createActivity", () => {
    const input = fanOutInvoiceSent(WS, "cust-1", "inv-1", "INV-0042", NOW);
    const fact = createActivity(input, NOW);
    expect(fact.kind).toBe("invoice_sent");
    expect(fact.source).toBe("system");
    expect(fact.customerId).toBe("cust-1");
  });
});

describe("buildTimeline — one feed, two sources", () => {
  it("sorts by occurredAt descending (most recent first)", () => {
    const facts = [
      createActivity(makeInput({ id: "a1", occurredAt: NOW - 2 * DAY }), NOW),
      createActivity(makeInput({ id: "a2", occurredAt: NOW }), NOW),
      createActivity(makeInput({ id: "a3", occurredAt: NOW - DAY }), NOW),
    ];
    const timeline = buildTimeline(facts, NOW);
    expect(timeline[0]!.fact.id).toBe("a2"); // most recent
    expect(timeline[1]!.fact.id).toBe("a3");
    expect(timeline[2]!.fact.id).toBe("a1");
  });

  it("buckets by age (today/this-week/this-month/older)", () => {
    const facts = [
      createActivity(makeInput({ id: "today", occurredAt: NOW - 1 * 60 * 60 * 1000 }), NOW), // 1h ago
      createActivity(makeInput({ id: "week", occurredAt: NOW - 3 * DAY }), NOW), // 3 days ago
      createActivity(makeInput({ id: "month", occurredAt: NOW - 15 * DAY }), NOW), // 15 days ago
      createActivity(makeInput({ id: "older", occurredAt: NOW - 60 * DAY }), NOW), // 60 days ago
    ];
    const timeline = buildTimeline(facts, NOW);
    const buckets = timeline.map((t) => t.bucket);
    expect(buckets).toContain("today");
    expect(buckets).toContain("this-week");
    expect(buckets).toContain("this-month");
    expect(buckets).toContain("older");
  });

  it("mixes system + manual facts in one timeline", () => {
    const facts = [
      createActivity(makeInput({ id: "manual", kind: "note", source: "manual" }), NOW),
      createActivity(
        makeInput({ id: "system", kind: "invoice_sent", source: "system", actor: "system", refId: "inv-1" }),
        NOW,
      ),
    ];
    const timeline = buildTimeline(facts, NOW);
    expect(timeline).toHaveLength(2);
    const sources = timeline.map((t) => t.fact.source);
    expect(sources).toContain("manual");
    expect(sources).toContain("system");
  });
});
