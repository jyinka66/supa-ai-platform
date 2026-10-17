/**
 * CSV import tests — the io-pass honesty contract.
 *
 * Covers:
 *   - parseCsv (quoted fields, escaped quotes, CRLF)
 *   - guessMappings (exact + fuzzy + skip)
 *   - applyMappingOverrides (user corrections)
 *   - extractRow (apply mapping to a row)
 *   - buildPreview (valid/skipped/duplicate status, skip reasons)
 *   - createImportBatch (undo unit, 30d reversible)
 *   - reverseBatch (within window + after throws)
 *   - the honesty contract: no partial mystery state
 */

import { describe, it, expect } from "vitest";
import {
  parseCsv,
  guessMappings,
  applyMappingOverrides,
  extractRow,
  buildPreview,
  buildSummary,
  createImportBatch,
  isBatchReversible,
  reverseBatch,
  BatchNotReversibleError,
} from "../src/import.js";
import { createCustomer, type Customer } from "../src/customer.js";
import type { WorkspaceId } from "@supa/workspace-core/workspace";
import { asCurrency } from "@supa/money/money";

const WS = "00000000-0000-0000-0000-000000000001" as WorkspaceId;
const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function makeCustomer(id: string, name: string, email?: string, phone?: string): Customer {
  return createCustomer({
    id,
    wsId: WS,
    name,
    businessName: null,
    emails: email ? [{ address: email, kind: "primary", verified: false }] : [],
    phones: phone ? [{ number: phone, kind: "mobile", primary: true }] : [],
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
// CSV parsing
// ───────────────────────────────────────────────

describe("parseCsv", () => {
  it("parses a simple CSV", () => {
    const csv = "name,email,phone\nMusa,musa@example.com,+2348012345678\nAisha,aisha@example.com,+2348087654321";
    const parsed = parseCsv(csv);
    expect(parsed.headers).toEqual(["name", "email", "phone"]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toEqual(["Musa", "musa@example.com", "+2348012345678"]);
  });

  it("handles quoted fields with commas", () => {
    const csv = 'name,notes\n"Ibrahim, Musa","likes coffee"';
    const parsed = parseCsv(csv);
    expect(parsed.rows[0]).toEqual(["Ibrahim, Musa", "likes coffee"]);
  });

  it("handles escaped quotes (\"\")", () => {
    const csv = 'name,notes\nMusa,"says ""hi"""';
    const parsed = parseCsv(csv);
    expect(parsed.rows[0]).toEqual(["Musa", 'says "hi"']);
  });

  it("handles CRLF line endings", () => {
    const csv = "name,email\r\nMusa,musa@example.com\r\n";
    const parsed = parseCsv(csv);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toEqual(["Musa", "musa@example.com"]);
  });

  it("handles empty input", () => {
    const parsed = parseCsv("");
    expect(parsed.headers).toEqual([]);
    expect(parsed.rows).toEqual([]);
  });
});

// ───────────────────────────────────────────────
// Column mapping — guessed + user-confirmed
// ───────────────────────────────────────────────

describe("guessMappings", () => {
  it("maps exact matches with confidence 1.0", () => {
    const headers = ["name", "email", "phone"];
    const mappings = guessMappings(headers);
    expect(mappings[0]).toMatchObject({ field: "name", confidence: 1.0, source: "exact" });
    expect(mappings[1]).toMatchObject({ field: "email", confidence: 1.0, source: "exact" });
    expect(mappings[2]).toMatchObject({ field: "phone", confidence: 1.0, source: "exact" });
  });

  it("maps common variations (Customer Name, E-mail, Mobile)", () => {
    const headers = ["Customer Name", "E-mail", "Mobile"];
    const mappings = guessMappings(headers);
    expect(mappings[0]!.field).toBe("name");
    expect(mappings[1]!.field).toBe("email");
    expect(mappings[2]!.field).toBe("phone");
  });

  it("maps fuzzy matches with confidence 0.8", () => {
    // Headers that CONTAIN the keyword but aren't exact variations.
    // "Full Name Here" contains "name" but isn't "name"/"customer name"/"full name".
    // "Contact Email" contains "email" but isn't "email"/"e-mail"/"email address".
    // "Cell Phone" contains "phone" but isn't "phone"/"phone number"/"mobile"/"tel".
    const headers = ["Full Name Here", "Contact Email", "Cell Phone"];
    const mappings = guessMappings(headers);
    expect(mappings[0]).toMatchObject({ field: "name", confidence: 0.8, source: "fuzzy" });
    expect(mappings[1]).toMatchObject({ field: "email", confidence: 0.8, source: "fuzzy" });
    expect(mappings[2]).toMatchObject({ field: "phone", confidence: 0.8, source: "fuzzy" });
  });

  it("skips unknown columns names with confidence 0", () => {
    const headers = ["random_column", "favorite_color"];
    const mappings = guessMappings(headers);
    expect(mappings[0]).toMatchObject({ field: "skip", confidence: 0, source: "heuristic" });
    expect(mappings[1]).toMatchObject({ field: "skip", confidence: 0, source: "heuristic" });
  });

  it("maps company/business/company name to businessName", () => {
    const headers = ["Company", "Business Name"];
    const mappings = guessMappings(headers);
    expect(mappings[0]!.field).toBe("businessName");
    expect(mappings[1]!.field).toBe("businessName");
  });
});

describe("applyMappingOverrides", () => {
  it("user can override a skipped column", () => {
    const guessed = guessMappings(["random_column"]);
    expect(guessed[0]!.field).toBe("skip");
    const overridden = applyMappingOverrides(guessed, { 0: "name" });
    expect(overridden[0]).toMatchObject({ field: "name", confidence: 1.0, source: "user" });
  });

  it("user can change a fuzzy mapping", () => {
    const guessed = guessMappings(["Full Name Here"]);
    expect(guessed[0]!.field).toBe("name");
    expect(guessed[0]!.confidence).toBe(0.8);
    const overridden = applyMappingOverrides(guessed, { 0: "businessName" });
    expect(overridden[0]).toMatchObject({ field: "businessName", confidence: 1.0, source: "user" });
  });

  it("unmodified mappings stay as guessed", () => {
    const guessed = guessMappings(["name", "email"]);
    const overridden = applyMappingOverrides(guessed, {});
    expect(overridden[0]!.source).toBe("exact");
    expect(overridden[1]!.source).toBe("exact");
  });
});

// ───────────────────────────────────────────────
// Row extraction
// ───────────────────────────────────────────────

describe("extractRow", () => {
  it("extracts fields based on mapping", () => {
    const mappings = guessMappings(["name", "email", "phone"]);
    const row = ["Musa Ibrahim", "musa@example.com", "+2348012345678"];
    const extracted = extractRow(row, mappings);
    expect(extracted.fields.name).toBe("Musa Ibrahim");
    expect(extracted.fields.email).toBe("musa@example.com");
    expect(extracted.fields.phone).toBe("+2348012345678");
  });

  it("ignores skipped columns", () => {
    const mappings = guessMappings(["name", "random_column", "email"]);
    const row = ["Musa", "ignored_value", "musa@example.com"];
    const extracted = extractRow(row, mappings);
    expect(extracted.fields.name).toBe("Musa");
    expect(extracted.fields.email).toBe("musa@example.com");
    expect((extracted.fields as any).random_column).toBeUndefined();
  });

  it("ignores empty values", () => {
    const mappings = guessMappings(["name", "email"]);
    const row = ["Musa", ""];
    const extracted = extractRow(row, mappings);
    expect(extracted.fields.name).toBe("Musa");
    expect(extracted.fields.email).toBeUndefined();
  });
});

// ───────────────────────────────────────────────
// Preview — the honesty contract
// ───────────────────────────────────────────────

describe("buildPreview", () => {
  it("marks valid rows as valid", () => {
    const csv = parseCsv("name,email\nMusa,musa@example.com");
    const mappings = guessMappings(csv.headers);
    const preview = buildPreview(csv, mappings, []);
    expect(preview.totalRows).toBe(1);
    expect(preview.validCount).toBe(1);
    expect(preview.skippedCount).toBe(0);
    expect(preview.rows[0]!.status).toBe("valid");
  });

  it("skips rows missing name (required)", () => {
    const csv = parseCsv("name,email\n,musa@example.com");
    const mappings = guessMappings(csv.headers);
    const preview = buildPreview(csv, mappings, []);
    expect(preview.skippedCount).toBe(1);
    expect(preview.rows[0]!.status).toBe("skipped");
    expect(preview.rows[0]!.skipReason).toBe("missing-name");
  });

  it("skips rows with invalid email", () => {
    const csv = parseCsv("name,email\nMusa,not-an-email");
    const mappings = guessMappings(csv.headers);
    const preview = buildPreview(csv, mappings, []);
    expect(preview.skippedCount).toBe(1);
    expect(preview.rows[0]!.skipReason).toBe("invalid-email");
  });

  it("skips rows with invalid phone (too few digits)", () => {
    const csv = parseCsv("name,phone\nMusa,123");
    const mappings = guessMappings(csv.headers);
    const preview = buildPreview(csv, mappings, []);
    expect(preview.skippedCount).toBe(1);
    expect(preview.rows[0]!.skipReason).toBe("invalid-phone");
  });

  it("skips empty rows", () => {
    const csv = parseCsv("name,email\n,");
    const mappings = guessMappings(csv.headers);
    const preview = buildPreview(csv, mappings, []);
    expect(preview.skippedCount).toBe(1);
    expect(preview.rows[0]!.skipReason).toBe("empty-row");
  });

  it("flags duplicate-in-batch (same email appears twice)", () => {
    const csv = parseCsv("name,email\nMusa,musa@example.com\nMusa2,musa@example.com");
    const mappings = guessMappings(csv.headers);
    const preview = buildPreview(csv, mappings, []);
    expect(preview.validCount).toBe(1);
    expect(preview.duplicateCount).toBe(1);
    expect(preview.rows[0]!.status).toBe("valid");
    expect(preview.rows[1]!.status).toBe("duplicate");
    expect(preview.rows[1]!.skipReason).toBe("duplicate-in-batch");
    expect(preview.rows[1]!.duplicateOfRow).toBe(0);
  });

  it("flags duplicate-in-batch (same phone appears twice)", () => {
    const csv = parseCsv("name,phone\nMusa,+2348012345678\nAisha,+2348012345678");
    const mappings = guessMappings(csv.headers);
    const preview = buildPreview(csv, mappings, [], { region: "NG" });
    expect(preview.duplicateCount).toBe(1);
    expect(preview.rows[1]!.skipReason).toBe("duplicate-in-batch");
  });

  it("flags duplicate-existing (matches an existing customer by email)", () => {
    const csv = parseCsv("name,email\nMusa,musa@example.com");
    const mappings = guessMappings(csv.headers);
    const existing = [makeCustomer("c1", "Existing", "musa@example.com")];
    const preview = buildPreview(csv, mappings, existing);
    expect(preview.duplicateCount).toBe(1);
    expect(preview.rows[0]!.status).toBe("duplicate");
    expect(preview.rows[0]!.skipReason).toBe("duplicate-existing");
    expect(preview.rows[0]!.duplicateOf).toBe("c1");
  });

  it("does NOT flag name-only matches as duplicate-existing (score 0.8 < 1.0)", () => {
    const csv = parseCsv("name,email\nMusa Ibrahim,");
    const mappings = guessMappings(csv.headers);
    const existing = [makeCustomer("c1", "Musa Ibrahim")];
    const preview = buildPreview(csv, mappings, existing);
    // Name match alone (score 0.8) is a hint, not a dupe — the row is valid.
    expect(preview.validCount).toBe(1);
    expect(preview.duplicateCount).toBe(0);
  });

  it("preview includes the mappings (so UI can show them)", () => {
    const csv = parseCsv("name,email\nMusa,musa@example.com");
    const mappings = guessMappings(csv.headers);
    const preview = buildPreview(csv, mappings, []);
    expect(preview.mappings).toBe(mappings);
  });
});

// ───────────────────────────────────────────────
// Summary — every skip reason reported
// ───────────────────────────────────────────────

describe("buildSummary", () => {
  it("counts each skip reason", () => {
    const csv = parseCsv("name,email\n,missing-name\nMusa,bad-email\nMusa2,musa2@example.com");
    const mappings = guessMappings(csv.headers);
    const preview = buildPreview(csv, mappings, []);
    // Row 0: missing name → skipped.
    // Row 1: "bad-email" fails email validation → skipped.
    // Row 2: valid.
    const summary = buildSummary(preview);
    expect(summary.totalRows).toBe(3);
    expect(summary.importedCount).toBe(1);
    expect(summary.skippedCount).toBe(2);
    expect(summary.skipReasons).toContainEqual({ reason: "missing-name", count: 1 });
    expect(summary.skipReasons).toContainEqual({ reason: "invalid-email", count: 1 });
  });

  it("handles no skips", () => {
    const csv = parseCsv("name,email\nMusa,musa@example.com");
    const mappings = guessMappings(csv.headers);
    const preview = buildPreview(csv, mappings, []);
    const summary = buildSummary(preview);
    expect(summary.skippedCount).toBe(0);
    expect(summary.skipReasons).toEqual([]);
  });
});

// ───────────────────────────────────────────────
// Import batch — the undo unit
// ───────────────────────────────────────────────

describe("createImportBatch", () => {
  it("creates a batch with created customer ids + 30d reversible window", () => {
    const csv = parseCsv("name,email\nMusa,musa@example.com\nAisha,aisha@example.com");
    const mappings = guessMappings(csv.headers);
    const preview = buildPreview(csv, mappings, []);
    const batch = createImportBatch("batch-1", WS, preview, ["c1", "c2"], NOW);
    expect(batch.id).toBe("batch-1");
    expect(batch.createdCustomerIds).toEqual(["c1", "c2"]);
    expect(batch.importedAt).toBe(NOW);
    expect(batch.reversibleUntil).toBe(NOW + 30 * DAY);
    expect(batch.reversedAt).toBeNull();
    expect(batch.summary.importedCount).toBe(2);
  });

  it("records duplicate customer ids (NOT created — for audit)", () => {
    const csv = parseCsv("name,email\nMusa,musa@example.com");
    const mappings = guessMappings(csv.headers);
    const existing = [makeCustomer("c1", "Existing", "musa@example.com")];
    const preview = buildPreview(csv, mappings, existing);
    const batch = createImportBatch("batch-1", WS, preview, [], NOW);
    expect(batch.createdCustomerIds).toEqual([]);
    expect(batch.duplicateCustomerIds).toEqual(["c1"]);
  });
});

describe("isBatchReversible", () => {
  it("reversible within 30 days", () => {
    const csv = parseCsv("name,email\nMusa,musa@example.com");
    const mappings = guessMappings(csv.headers);
    const preview = buildPreview(csv, mappings, []);
    const batch = createImportBatch("batch-1", WS, preview, ["c1"], NOW);
    expect(isBatchReversible(batch, NOW + 1)).toBe(true);
    expect(isBatchReversible(batch, NOW + 29 * DAY)).toBe(true);
  });

  it("not reversible after 30 days", () => {
    const csv = parseCsv("name,email\nMusa,musa@example.com");
    const mappings = guessMappings(csv.headers);
    const preview = buildPreview(csv, mappings, []);
    const batch = createImportBatch("batch-1", WS, preview, ["c1"], NOW);
    expect(isBatchReversible(batch, NOW + 31 * DAY)).toBe(false);
  });

  it("not reversible if already reversed", () => {
    const csv = parseCsv("name,email\nMusa,musa@example.com");
    const mappings = guessMappings(csv.headers);
    const preview = buildPreview(csv, mappings, []);
    const batch = createImportBatch("batch-1", WS, preview, ["c1"], NOW);
    const reversed = reverseBatch(batch, NOW + 1);
    expect(isBatchReversible(reversed, NOW + 2)).toBe(false);
  });
});

describe("reverseBatch", () => {
  it("reverses within the 30-day window", () => {
    const csv = parseCsv("name,email\nMusa,musa@example.com");
    const mappings = guessMappings(csv.headers);
    const preview = buildPreview(csv, mappings, []);
    const batch = createImportBatch("batch-1", WS, preview, ["c1"], NOW);
    const reversed = reverseBatch(batch, NOW + 5 * DAY);
    expect(reversed.reversedAt).toBe(NOW + 5 * DAY);
  });

  it("throws after the 30-day window", () => {
    const csv = parseCsv("name,email\nMusa,musa@example.com");
    const mappings = guessMappings(csv.headers);
    const preview = buildPreview(csv, mappings, []);
    const batch = createImportBatch("batch-1", WS, preview, ["c1"], NOW);
    expect(() => reverseBatch(batch, NOW + 31 * DAY)).toThrow(BatchNotReversibleError);
  });

  it("throws if already reversed", () => {
    const csv = parseCsv("name,email\nMusa,musa@example.com");
    const mappings = guessMappings(csv.headers);
    const preview = buildPreview(csv, mappings, []);
    const batch = createImportBatch("batch-1", WS, preview, ["c1"], NOW);
    const reversed = reverseBatch(batch, NOW + 1);
    expect(() => reverseBatch(reversed, NOW + 2)).toThrow(BatchNotReversibleError);
  });
});

// ───────────────────────────────────────────────
// The honesty contract — no partial mystery state
// ───────────────────────────────────────────────

describe("honesty contract — no partial mystery state", () => {
  it("every skipped row has a reason", () => {
    const csv = parseCsv("name,email\n,missing-name\nMusa,bad-email\nMusa2,musa2@example.com\n,another-missing");
    const mappings = guessMappings(csv.headers);
    const preview = buildPreview(csv, mappings, []);
    for (const row of preview.rows) {
      if (row.status === "skipped") {
        expect(row.skipReason).not.toBeNull();
      }
    }
  });

  it("every duplicate is flagged (not silently skipped)", () => {
    const csv = parseCsv("name,email\nMusa,dup@example.com\nMusa2,dup@example.com");
    const mappings = guessMappings(csv.headers);
    const preview = buildPreview(csv, mappings, []);
    // The second row is flagged as duplicate, not silently skipped.
    expect(preview.rows[1]!.status).toBe("duplicate");
    expect(preview.rows[1]!.skipReason).toBe("duplicate-in-batch");
    expect(preview.rows[1]!.duplicateOfRow).toBe(0);
  });

  it("every guessed mapping is shown (confidence + source)", () => {
    const csv = parseCsv("Full Name Here,Email Address,random_column");
    const mappings = guessMappings(csv.headers);
    const preview = buildPreview(csv, mappings, []);
    expect(preview.mappings).toHaveLength(3);
    // Every mapping has a confidence + source — the UI shows them.
    for (const m of preview.mappings) {
      expect(typeof m.confidence).toBe("number");
      expect(m.source).toMatch(/^(exact|fuzzy|heuristic|user)$/);
    }
  });

  it("batch records exactly what was created (for undo)", () => {
    const csv = parseCsv("name,email\nMusa,musa@example.com\nAisha,aisha@example.com");
    const mappings = guessMappings(csv.headers);
    const preview = buildPreview(csv, mappings, []);
    const batch = createImportBatch("batch-1", WS, preview, ["c1", "c2"], NOW);
    // Undo = reverse the batch. The batch knows exactly which customers
    // it created, so undo can archive them precisely.
    expect(batch.createdCustomerIds).toEqual(["c1", "c2"]);
    expect(batch.summary.importedCount).toBe(2);
  });
});
