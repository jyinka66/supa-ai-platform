/**
 * Duplicates tests — detection + merge.
 *
 * Covers:
 *   - normalization (phone E.164, email lowercase, name token-sort + diacritics)
 *   - duplicate detection (email/phone/name signals, scored candidates)
 *   - merge record construction (30-day reversible window)
 *   - merge reversal (within window + after window throws)
 *   - field resolution (per-field survivor/merged choice)
 *   - tags/groups union on merge
 */

import { describe, it, expect } from "vitest";
import {
  normalizePhone,
  normalizeEmail,
  normalizeName,
  detectDuplicates,
  buildMergeRecord,
  isReversible,
  reverseMerge,
  resolveMergedFields,
  MergeNotReversibleError,
  type MergePlan,
} from "../src/duplicates.js";
import { createCustomer, type Customer } from "../src/customer.js";
import type { WorkspaceId } from "@supa/workspace-core/workspace";
import { asCurrency } from "@supa/money/money";

const WS = "00000000-0000-0000-0000-000000000001" as WorkspaceId;
const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function makeCustomer(overrides: Partial<Customer> & { id: string }): Customer {
  return createCustomer({
    id: overrides.id,
    wsId: WS,
    name: overrides.name ?? "Test Customer",
    businessName: null,
    emails: overrides.emails ?? [],
    phones: overrides.phones ?? [],
    addresses: [],
    currency: asCurrency("NGN"),
    taxId: null,
    tags: [],
    groups: [],
    notes: "",
    createdBy: "user-1",
  }, NOW);
}

// ───────────────────────────────────────────────
// Normalization
// ───────────────────────────────────────────────

describe("normalizePhone", () => {
  it("strips non-digits and prepends +", () => {
    expect(normalizePhone("+234 801 234 5678")).toBe("+2348012345678");
    expect(normalizePhone("+1 (555) 123-4567")).toBe("+15551234567");
  });

  it("NG region: strips leading 0, prepends +234", () => {
    expect(normalizePhone("08012345678", "NG")).toBe("+2348012345678");
    expect(normalizePhone("080 123 45678", "NG")).toBe("+2348012345678");
  });

  it("US region: strips leading 1, prepends +1", () => {
    expect(normalizePhone("15551234567", "US")).toBe("+15551234567");
  });

  it("GB region: strips leading 0, prepends +44", () => {
    expect(normalizePhone("02079460958", "GB")).toBe("+442079460958");
  });

  it("fallback: prepends + for unknown region", () => {
    expect(normalizePhone("1234567890")).toBe("+1234567890");
  });
});

describe("normalizeEmail", () => {
  it("lowercases + trims", () => {
    expect(normalizeEmail("  Musa@Example.COM  ")).toBe("musa@example.com");
  });

  it("does not canonicalize gmail dots (rabbit hole avoided)", () => {
    // We intentionally don't try to canonicalize gmail dots or +aliases.
    expect(normalizeEmail("musa.ibrahim@gmail.com")).toBe("musa.ibrahim@gmail.com");
    expect(normalizeEmail("musaibrahim@gmail.com")).toBe("musaibrahim@gmail.com");
    // These are different — that's correct; we catch 95% with simple normalize.
  });
});

describe("normalizeName", () => {
  it("lowercases + trims", () => {
    expect(normalizeName("  Musa Ibrahim  ")).toBe("ibrahim musa");
  });

  it("sorts tokens (word-order independent)", () => {
    expect(normalizeName("Musa Ibrahim")).toBe(normalizeName("Ibrahim Musa"));
  });

  it("folds diacritics (é → e)", () => {
    expect(normalizeName("José Núñez")).toBe("jose nunez");
  });

  it("transliterates common Arabic names", () => {
    expect(normalizeName("إبراهيم موسى")).toBe("ibrahim musa");
  });

  it("handles empty name", () => {
    expect(normalizeName("")).toBe("");
    expect(normalizeName("   ")).toBe("");
  });
});

// ───────────────────────────────────────────────
// Duplicate detection
// ───────────────────────────────────────────────

describe("detectDuplicates", () => {
  it("detects email match (score 1.0)", () => {
    const existing = [
      makeCustomer({ id: "c1", emails: [{ address: "musa@example.com", kind: "primary", verified: false }] }),
    ];
    const candidate = {
      name: "Different Name",
      emails: [{ address: "musa@example.com" }],
      phones: [],
    };
    const dupes = detectDuplicates(candidate, existing);
    expect(dupes).toHaveLength(1);
    expect(dupes[0]!.customer.id).toBe("c1");
    expect(dupes[0]!.score).toBe(1.0);
    expect(dupes[0]!.signals[0]!.kind).toBe("email");
  });

  it("detects phone match (score 1.0)", () => {
    const existing = [
      makeCustomer({ id: "c1", phones: [{ number: "+2348012345678", kind: "mobile", primary: true }] }),
    ];
    const candidate = {
      name: "Different",
      emails: [],
      phones: [{ number: "08012345678" }], // NG format, will normalize
    };
    const dupes = detectDuplicates(candidate, existing, "NG");
    expect(dupes).toHaveLength(1);
    expect(dupes[0]!.score).toBe(1.0);
    expect(dupes[0]!.signals[0]!.kind).toBe("phone");
  });

  it("detects name match (score 0.8 — name alone isn't a dupe)", () => {
    const existing = [makeCustomer({ id: "c1", name: "Musa Ibrahim" })];
    const candidate = {
      name: "Ibrahim Musa", // token-sorted equal
      emails: [],
      phones: [],
    };
    const dupes = detectDuplicates(candidate, existing);
    expect(dupes).toHaveLength(1);
    expect(dupes[0]!.score).toBe(0.8);
    expect(dupes[0]!.signals[0]!.kind).toBe("name");
  });

  it("returns empty for no matches", () => {
    const existing = [makeCustomer({ id: "c1", name: "Other Person", emails: [], phones: [] })];
    const candidate = {
      name: "Completely Different",
      emails: [{ address: "new@example.com" }],
      phones: [],
    };
    const dupes = detectDuplicates(candidate, existing);
    expect(dupes).toHaveLength(0);
  });

  it("returns scored candidates, never auto-merged", () => {
    // The function returns candidates; it does NOT merge. The caller decides.
    const existing = [
      makeCustomer({ id: "c1", emails: [{ address: "dup@example.com", kind: "primary", verified: false }] }),
    ];
    const candidate = {
      name: "New Person",
      emails: [{ address: "dup@example.com" }],
      phones: [],
    };
    const dupes = detectDuplicates(candidate, existing);
    expect(dupes).toHaveLength(1);
    // The return type is DuplicateCandidate[] — no merge happens here.
    expect(dupes[0]!.customer).toBeDefined();
    expect(dupes[0]!.score).toBe(1.0);
  });

  it("sorts by score descending", () => {
    const existing = [
      makeCustomer({ id: "high", emails: [{ address: "exact@example.com", kind: "primary", verified: false }] }),
      makeCustomer({ id: "low", name: "Musa Ibrahim" }),
    ];
    const candidate = {
      name: "Musa Ibrahim",
      emails: [{ address: "exact@example.com" }],
      phones: [],
    };
    const dupes = detectDuplicates(candidate, existing);
    expect(dupes[0]!.customer.id).toBe("high"); // score 1.0
    expect(dupes[1]!.customer.id).toBe("low");  // score 0.8
  });
});

// ───────────────────────────────────────────────
// Merge — a FACT, not a destructive edit
// ───────────────────────────────────────────────

describe("buildMergeRecord", () => {
  it("creates a merge record with 30-day reversible window", () => {
    const plan: MergePlan = { survivorId: "c1", mergedId: "c2", fieldResolutions: {} };
    const record = buildMergeRecord(plan, WS, "merge-1", NOW);
    expect(record.survivorId).toBe("c1");
    expect(record.mergedId).toBe("c2");
    expect(record.mergedAt).toBe(NOW);
    expect(record.reversibleUntil).toBe(NOW + 30 * DAY);
    expect(record.reversedAt).toBeNull();
  });

  it("is reversible within 30 days", () => {
    const plan: MergePlan = { survivorId: "c1", mergedId: "c2", fieldResolutions: {} };
    const record = buildMergeRecord(plan, WS, "merge-1", NOW);
    expect(isReversible(record, NOW + 1)).toBe(true);
    expect(isReversible(record, NOW + 29 * DAY)).toBe(true);
  });

  it("is NOT reversible after 30 days", () => {
    const plan: MergePlan = { survivorId: "c1", mergedId: "c2", fieldResolutions: {} };
    const record = buildMergeRecord(plan, WS, "merge-1", NOW);
    expect(isReversible(record, NOW + 31 * DAY)).toBe(false);
  });

  it("is NOT reversible if already reversed", () => {
    const plan: MergePlan = { survivorId: "c1", mergedId: "c2", fieldResolutions: {} };
    const record = buildMergeRecord(plan, WS, "merge-1", NOW);
    const reversed = reverseMerge(record, NOW + 1);
    expect(isReversible(reversed, NOW + 2)).toBe(false);
  });
});

describe("reverseMerge", () => {
  it("reverses within the 30-day window", () => {
    const plan: MergePlan = { survivorId: "c1", mergedId: "c2", fieldResolutions: {} };
    const record = buildMergeRecord(plan, WS, "merge-1", NOW);
    const reversed = reverseMerge(record, NOW + 5 * DAY);
    expect(reversed.reversedAt).toBe(NOW + 5 * DAY);
  });

  it("throws after the 30-day window", () => {
    const plan: MergePlan = { survivorId: "c1", mergedId: "c2", fieldResolutions: {} };
    const record = buildMergeRecord(plan, WS, "merge-1", NOW);
    expect(() => reverseMerge(record, NOW + 31 * DAY)).toThrow(MergeNotReversibleError);
  });

  it("throws if already reversed", () => {
    const plan: MergePlan = { survivorId: "c1", mergedId: "c2", fieldResolutions: {} };
    const record = buildMergeRecord(plan, WS, "merge-1", NOW);
    const reversed = reverseMerge(record, NOW + 1);
    expect(() => reverseMerge(reversed, NOW + 2)).toThrow(MergeNotReversibleError);
  });
});

describe("resolveMergedFields", () => {
  it("picks survivor's value when resolution is 'survivor'", () => {
    const survivor = makeCustomer({ id: "c1", name: "Survivor Name" });
    const merged = makeCustomer({ id: "c2", name: "Merged Name" });
    const resolved = resolveMergedFields(survivor, merged, { name: "survivor" });
    expect(resolved.name).toBe("Survivor Name");
  });

  it("picks merged's value when resolution is 'merged'", () => {
    const survivor = makeCustomer({ id: "c1", name: "Survivor Name" });
    const merged = makeCustomer({ id: "c2", name: "Merged Name" });
    const resolved = resolveMergedFields(survivor, merged, { name: "merged" });
    expect(resolved.name).toBe("Merged Name");
  });

  it("defaults to survivor for unspecified fields", () => {
    const survivor = makeCustomer({ id: "c1", name: "Survivor" });
    const merged = makeCustomer({ id: "c2", name: "Merged" });
    const resolved = resolveMergedFields(survivor, merged, {});
    expect(resolved.name).toBe("Survivor");
  });

  it("unions tags from both customers", () => {
    const survivor = makeCustomer({ id: "c1" });
    const merged = makeCustomer({ id: "c2" });
    const survivorWithTags = { ...survivor, tags: ["vip", "lagos"] };
    const mergedWithTags = { ...merged, tags: ["wholesale", "lagos"] };
    const resolved = resolveMergedFields(survivorWithTags, mergedWithTags, {});
    expect(resolved.tags.sort()).toEqual(["lagos", "vip", "wholesale"]);
  });

  it("unions groups from both customers", () => {
    const survivor = { ...makeCustomer({ id: "c1" }), groups: ["group-a"] };
    const merged = { ...makeCustomer({ id: "c2" }), groups: ["group-b", "group-a"] };
    const resolved = resolveMergedFields(survivor, merged, {});
    expect(resolved.groups.sort()).toEqual(["group-a", "group-b"]);
  });

  it("appends merged notes to survivor notes", () => {
    const survivor = { ...makeCustomer({ id: "c1" }), notes: "Survivor notes" };
    const merged = { ...makeCustomer({ id: "c2" }), notes: "Merged notes" };
    const resolved = resolveMergedFields(survivor, merged, {});
    expect(resolved.notes).toContain("Survivor notes");
    expect(resolved.notes).toContain("Merged notes");
    expect(resolved.notes).toContain("Merged from Test Customer");
  });
});
