/**
 * @supa/customers/import
 * ----------------------------------------------------------------
 * CSV import = the io-pass honesty contract, restated:
 *   - column mapping UI with live preview
 *   - every guessed mapping shown explicitly
 *   - every skipped row reported with its reason
 *   - duplicates flagged not silently skipped
 *   - import produces an import-batch id; undo = reverse the batch
 *   - no partial mystery state — either the batch commits clean or
 *     the report tells you exactly what didn't and why
 * ----------------------------------------------------------------
 */

import type { WorkspaceId } from "@supa/workspace-core/workspace";
import type { Currency } from "@supa/money/money";
import type { Customer } from "./customer.js";
import {
  normalizePhone,
  normalizeEmail,
  detectDuplicates,
  type DuplicateCandidate,
} from "./duplicates.js";

// ───────────────────────────────────────────────
// CSV parsing — minimal, no external dep
// ───────────────────────────────────────────────

/**
 * Parse a CSV string into rows + header. Handles quoted fields,
 * escaped quotes (""), and CRLF line endings. Does NOT handle
 * embedded newlines in quoted fields (the caller should pre-split
 * if needed — keeps the parser simple + honest).
 */
export interface ParsedCsv {
  readonly headers: readonly string[];
  readonly rows: ReadonlyArray<readonly string[]>;
}

export function parseCsv(csv: string): ParsedCsv {
  const lines = csv.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) {
    return { headers: [], rows: [] };
  }
  const headers = parseCsvLine(lines[0]!);
  const rows = lines.slice(1).map((line) => parseCsvLine(line));
  return { headers, rows };
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++; // skip escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

// ───────────────────────────────────────────────
// Column mapping — guessed + user-confirmed
// ───────────────────────────────────────────────

export type CustomerField =
  | "name"
  | "businessName"
  | "email"
  | "phone"
  | "addressLine1"
  | "addressCity"
  | "addressCountry"
  | "taxId"
  | "tag"
  | "group"
  | "notes"
  | "skip";

/**
 * A column mapping. `field` is the customer field this CSV column
 * maps to; `confidence` is how sure the guess is (1.0 = exact match,
 * 0.8 = fuzzy, 0.5 = weak heuristic, 0 = user must confirm).
 *
 * Every guessed mapping is shown explicitly — the user sees the
 * confidence + can override before import.
 */
export interface ColumnMapping {
  readonly columnIndex: number;
  readonly headerName: string;
  readonly field: CustomerField;
  readonly confidence: number;
  readonly source: "exact" | "fuzzy" | "heuristic" | "user";
}

/**
 * Guess column mappings from headers. The guesser is intentionally
 * conservative: it only maps columns it's confident about; everything
 * else defaults to "skip" with confidence 0 (user must confirm).
 */
export function guessMappings(headers: readonly string[]): ColumnMapping[] {
  return headers.map((header, index) => {
    const lower = header.toLowerCase().trim();
    // Exact matches.
    if (lower === "name" || lower === "customer name" || lower === "full name") {
      return { columnIndex: index, headerName: header, field: "name", confidence: 1.0, source: "exact" };
    }
    if (lower === "business" || lower === "business name" || lower === "company" || lower === "company name") {
      return { columnIndex: index, headerName: header, field: "businessName", confidence: 1.0, source: "exact" };
    }
    if (lower === "email" || lower === "e-mail" || lower === "email address") {
      return { columnIndex: index, headerName: header, field: "email", confidence: 1.0, source: "exact" };
    }
    if (lower === "phone" || lower === "phone number" || lower === "mobile" || lower === "tel") {
      return { columnIndex: index, headerName: header, field: "phone", confidence: 1.0, source: "exact" };
    }
    if (lower === "address" || lower === "address line 1" || lower === "street") {
      return { columnIndex: index, headerName: header, field: "addressLine1", confidence: 1.0, source: "exact" };
    }
    if (lower === "city") {
      return { columnIndex: index, headerName: header, field: "addressCity", confidence: 1.0, source: "exact" };
    }
    if (lower === "country" || lower === "country code") {
      return { columnIndex: index, headerName: header, field: "addressCountry", confidence: 1.0, source: "exact" };
    }
    if (lower === "tax id" || lower === "tin" || lower === "vat number") {
      return { columnIndex: index, headerName: header, field: "taxId", confidence: 1.0, source: "exact" };
    }
    if (lower === "tag" || lower === "tags") {
      return { columnIndex: index, headerName: header, field: "tag", confidence: 1.0, source: "exact" };
    }
    if (lower === "group" || lower === "groups" || lower === "category") {
      return { columnIndex: index, headerName: header, field: "group", confidence: 1.0, source: "exact" };
    }
    if (lower === "notes" || lower === "note" || lower === "comment") {
      return { columnIndex: index, headerName: header, field: "notes", confidence: 1.0, source: "exact" };
    }
    // Fuzzy matches (contains).
    if (lower.includes("name")) {
      return { columnIndex: index, headerName: header, field: "name", confidence: 0.8, source: "fuzzy" };
    }
    if (lower.includes("email") || lower.includes("mail")) {
      return { columnIndex: index, headerName: header, field: "email", confidence: 0.8, source: "fuzzy" };
    }
    if (lower.includes("phone") || lower.includes("mobile") || lower.includes("tel")) {
      return { columnIndex: index, headerName: header, field: "phone", confidence: 0.8, source: "fuzzy" };
    }
    if (lower.includes("company") || lower.includes("business")) {
      return { columnIndex: index, headerName: header, field: "businessName", confidence: 0.8, source: "fuzzy" };
    }
    if (lower.includes("address") || lower.includes("street")) {
      return { columnIndex: index, headerName: header, field: "addressLine1", confidence: 0.8, source: "fuzzy" };
    }
    if (lower.includes("city")) {
      return { columnIndex: index, headerName: header, field: "addressCity", confidence: 0.8, source: "fuzzy" };
    }
    // No match — skip (user must confirm).
    return { columnIndex: index, headerName: header, field: "skip", confidence: 0, source: "heuristic" };
  });
}

/**
 * Apply user overrides to guessed mappings. The user can change any
 * column's field (e.g. set a "skip" column to "name" if the guesser
 * missed it). Returns the final mappings.
 */
export function applyMappingOverrides(
  guessed: readonly ColumnMapping[],
  overrides: Record<number, CustomerField>,
): ColumnMapping[] {
  return guessed.map((m) => {
    if (overrides[m.columnIndex] !== undefined && overrides[m.columnIndex] !== m.field) {
      return { ...m, field: overrides[m.columnIndex]!, confidence: 1.0, source: "user" };
    }
    return m;
  });
}

// ───────────────────────────────────────────────
// Row extraction — apply mapping to a CSV row
// ───────────────────────────────────────────────

export interface ExtractedRow {
  /** The raw CSV row values. */
  readonly raw: readonly string[];
  /** Extracted customer fields (only non-skip mappings). */
  readonly fields: Partial<{
    name: string;
    businessName: string;
    email: string;
    phone: string;
    addressLine1: string;
    addressCity: string;
    addressCountry: string;
    taxId: string;
    tag: string;
    group: string;
    notes: string;
  }>;
}

/**
 * Apply the column mapping to a single CSV row, extracting the
 * customer fields. Skipped columns are ignored.
 */
export function extractRow(
  row: readonly string[],
  mappings: readonly ColumnMapping[],
): ExtractedRow {
  const fields: ExtractedRow["fields"] = {};
  for (const mapping of mappings) {
    if (mapping.field === "skip") continue;
    const value = row[mapping.columnIndex]?.trim() ?? "";
    if (value === "") continue;
    switch (mapping.field) {
      case "name": fields.name = value; break;
      case "businessName": fields.businessName = value; break;
      case "email": fields.email = value; break;
      case "phone": fields.phone = value; break;
      case "addressLine1": fields.addressLine1 = value; break;
      case "addressCity": fields.addressCity = value; break;
      case "addressCountry": fields.addressCountry = value; break;
      case "taxId": fields.taxId = value; break;
      case "tag": fields.tag = value; break;
      case "group": fields.group = value; break;
      case "notes": fields.notes = value; break;
    }
  }
  return { raw: row, fields };
}

// ───────────────────────────────────────────────
// Import preview — the honesty contract
// ───────────────────────────────────────────────

export type SkipReason =
  | "missing-name"          // name is required
  | "invalid-email"         // email doesn't parse
  | "invalid-phone"         // phone doesn't normalize
  | "empty-row"             // row is entirely empty
  | "duplicate-in-batch"    // same email/phone appears earlier in this batch
  | "duplicate-existing";   // matches an existing customer

export interface PreviewRow {
  readonly rowIndex: number;
  readonly raw: readonly string[];
  readonly fields: ExtractedRow["fields"];
  readonly status: "valid" | "skipped" | "duplicate";
  readonly skipReason: SkipReason | null;
  readonly duplicateOf: string | null;
  /** For duplicate-in-batch: the row index this duplicates. */
  readonly duplicateOfRow: number | null;
}

export interface ImportPreview {
  readonly totalRows: number;
  readonly validCount: number;
  readonly skippedCount: number;
  readonly duplicateCount: number;
  readonly rows: readonly PreviewRow[];
  readonly mappings: readonly ColumnMapping[];
}

/**
 * Build an import preview. This is the honesty contract:
 *   - every guessed mapping is shown (the caller passes them)
 *   - every skipped row is reported with its reason
 *   - duplicates are flagged (in-batch + against existing customers)
 *
 * The preview is shown to the user BEFORE the import commits. The
 * user can fix mappings + re-preview, or accept the preview as-is.
 */
export function buildPreview(
  csv: ParsedCsv,
  mappings: readonly ColumnMapping[],
  existing: ReadonlyArray<Customer>,
  opts?: { region?: string },
): ImportPreview {
  const rows: PreviewRow[] = [];
  // Track emails/phones seen earlier in this batch (for duplicate-in-batch).
  const batchEmails = new Map<string, number>();
  const batchPhones = new Map<string, number>();

  for (let i = 0; i < csv.rows.length; i++) {
    const rawRow = csv.rows[i]!;
    const extracted = extractRow(rawRow, mappings);

    // Skip empty rows.
    const allEmpty = Object.values(extracted.fields).every((v) => !v);
    if (allEmpty) {
      rows.push({
        rowIndex: i,
        raw: rawRow,
        fields: extracted.fields,
        status: "skipped",
        skipReason: "empty-row",
        duplicateOf: null,
        duplicateOfRow: null,
      });
      continue;
    }

    // Required: name.
    if (!extracted.fields.name) {
      rows.push({
        rowIndex: i,
        raw: rawRow,
        fields: extracted.fields,
        status: "skipped",
        skipReason: "missing-name",
        duplicateOf: null,
        duplicateOfRow: null,
      });
      continue;
    }

    // Validate email format.
    if (extracted.fields.email) {
      if (!isValidEmail(extracted.fields.email)) {
        rows.push({
          rowIndex: i,
          raw: rawRow,
          fields: extracted.fields,
          status: "skipped",
          skipReason: "invalid-email",
          duplicateOf: null,
          duplicateOfRow: null,
        });
        continue;
      }
    }

    // Validate phone format.
    if (extracted.fields.phone) {
      if (!isValidPhone(extracted.fields.phone)) {
        rows.push({
          rowIndex: i,
          raw: rawRow,
          fields: extracted.fields,
          status: "skipped",
          skipReason: "invalid-phone",
          duplicateOf: null,
          duplicateOfRow: null,
        });
        continue;
      }
    }

    // Check for duplicate-in-batch (same email or phone as an earlier row).
    if (extracted.fields.email) {
      const normalized = normalizeEmail(extracted.fields.email);
      const earlierRow = batchEmails.get(normalized);
      if (earlierRow !== undefined) {
        rows.push({
          rowIndex: i,
          raw: rawRow,
          fields: extracted.fields,
          status: "duplicate",
          skipReason: "duplicate-in-batch",
          duplicateOf: null,
          duplicateOfRow: earlierRow,
        });
        continue;
      }
      batchEmails.set(normalized, i);
    }
    if (extracted.fields.phone) {
      const normalized = normalizePhone(extracted.fields.phone, opts?.region);
      const earlierRow = batchPhones.get(normalized);
      if (earlierRow !== undefined) {
        rows.push({
          rowIndex: i,
          raw: rawRow,
          fields: extracted.fields,
          status: "duplicate",
          skipReason: "duplicate-in-batch",
          duplicateOf: null,
          duplicateOfRow: earlierRow,
        });
        continue;
      }
      batchPhones.set(normalized, i);
    }

    // Check for duplicate-existing (matches an existing customer).
    const dupes = detectDuplicates(
      {
        name: extracted.fields.name,
        emails: extracted.fields.email ? [{ address: extracted.fields.email }] : [],
        phones: extracted.fields.phone ? [{ number: extracted.fields.phone }] : [],
      },
      existing,
      opts?.region,
    );
    if (dupes.length > 0 && dupes[0]!.score >= 1.0) {
      rows.push({
        rowIndex: i,
        raw: rawRow,
        fields: extracted.fields,
        status: "duplicate",
        skipReason: "duplicate-existing",
        duplicateOf: dupes[0]!.customer.id,
        duplicateOfRow: null,
      });
      continue;
    }

    // Valid row.
    rows.push({
      rowIndex: i,
      raw: rawRow,
      fields: extracted.fields,
      status: "valid",
      skipReason: null,
      duplicateOf: null,
      duplicateOfRow: null,
    });
  }

  const validCount = rows.filter((r) => r.status === "valid").length;
  const skippedCount = rows.filter((r) => r.status === "skipped").length;
  const duplicateCount = rows.filter((r) => r.status === "duplicate").length;

  return {
    totalRows: csv.rows.length,
    validCount,
    skippedCount,
    duplicateCount,
    rows,
    mappings,
  };
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidPhone(phone: string): boolean {
  // At least 7 digits after stripping non-digits.
  const digits = phone.replace(/[^\d]/g, "");
  return digits.length >= 7;
}

// ───────────────────────────────────────────────
// Import batch — the undo unit
// ───────────────────────────────────────────────

export interface ImportBatch {
  readonly id: string;
  readonly wsId: WorkspaceId;
  readonly importedAt: number;
  /** Customer ids created by this batch (for undo). */
  readonly createdCustomerIds: readonly string[];
  /** Customer ids that were skipped as duplicates (NOT created). */
  readonly duplicateCustomerIds: readonly string[];
  /** Summary of the import (counts + skip reasons). */
  readonly summary: ImportSummary;
  /** Reversible for 30 days (same as merge). */
  readonly reversibleUntil: number;
  readonly reversedAt: number | null;
}

export interface ImportSummary {
  readonly totalRows: number;
  readonly importedCount: number;
  readonly skippedCount: number;
  readonly duplicateCount: number;
  readonly skipReasons: ReadonlyArray<{ reason: SkipReason; count: number }>;
}

/**
 * Build the import summary from a preview. Counts each skip reason
 * so the report tells you exactly what didn't import and why.
 */
export function buildSummary(preview: ImportPreview): ImportSummary {
  const reasonCounts = new Map<SkipReason, number>();
  for (const row of preview.rows) {
    if (row.skipReason) {
      reasonCounts.set(row.skipReason, (reasonCounts.get(row.skipReason) ?? 0) + 1);
    }
  }
  return {
    totalRows: preview.totalRows,
    importedCount: preview.validCount,
    skippedCount: preview.skippedCount,
    duplicateCount: preview.duplicateCount,
    skipReasons: [...reasonCounts.entries()].map(([reason, count]) => ({ reason, count })),
  };
}

/**
 * Create an import batch record. The batch is the undo unit:
 *   - `createdCustomerIds` lists every customer created by this batch.
 *   - Undo = archive every customer in that list (soft archive, same
 *     discipline as the rest of the system — never delete).
 *   - Reversible for 30 days; after that, the batch is still auditable.
 */
export function createImportBatch(
  id: string,
  wsId: WorkspaceId,
  preview: ImportPreview,
  createdCustomerIds: readonly string[],
  now: number = Date.now(),
): ImportBatch {
  const thirtyDays = 30 * 86_400_000;
  return {
    id,
    wsId,
    importedAt: now,
    createdCustomerIds,
    duplicateCustomerIds: preview.rows
      .filter((r) => r.status === "duplicate" && r.duplicateOf)
      .map((r) => r.duplicateOf!),
    summary: buildSummary(preview),
    reversibleUntil: now + thirtyDays,
    reversedAt: null,
  };
}

/**
 * Check if an import batch is still reversible.
 */
export function isBatchReversible(batch: ImportBatch, now: number = Date.now()): boolean {
  if (batch.reversedAt !== null) return false;
  return now <= batch.reversibleUntil;
}

/**
 * Reverse an import batch (undo). Archives every customer created by
 * the batch. Only callable within the 30-day window; after that,
 * throws (the batch is permanent but auditable).
 */
export function reverseBatch(
  batch: ImportBatch,
  now: number = Date.now(),
): ImportBatch {
  if (!isBatchReversible(batch, now)) {
    throw new BatchNotReversibleError(
      `batch ${batch.id} is not reversible (window expired or already reversed)`,
    );
  }
  return { ...batch, reversedAt: now };
}

export class BatchNotReversibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BatchNotReversibleError";
  }
}

// ───────────────────────────────────────────────
// Import repository contract
// ───────────────────────────────────────────────

export interface ImportRepository {
  /**
   * Execute the import: create customers for every valid row in the
   * preview, in a single DB transaction. Returns the batch record.
   *
   * No partial mystery state: either the batch commits clean (every
   * valid row creates a customer) or the transaction rolls back
   * (nothing imports — the user re-runs after fixing).
   */
  execute(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    preview: ImportPreview,
    mappings: readonly ColumnMapping[],
    defaultCurrency: Currency,
    batchId: string,
  ): Promise<ImportBatch>;

  /** Reverse a batch (undo — archives created customers). */
  reverse(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    batchId: string,
  ): Promise<ImportBatch>;

  /** Find a batch by id (for audit). */
  findById(
    scope: import("@supa/workspace-core/workspace").WorkspaceScope,
    id: string,
  ): Promise<ImportBatch | null>;
}
