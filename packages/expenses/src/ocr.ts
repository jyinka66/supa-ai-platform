/**
 * @supa/expenses/ocr
 * ----------------------------------------------------------------
 * OCR extraction: { merchant, amount, currency, date, tax line? }
 *   with a confidence per field. The ONLY path into the expense
 *   record is the confirmation UI: extracted fields rendered as a
 *   pre-filled form, visibly marked as suggestions, fields under
 *   threshold highlighted, user edits or taps Save. The system
 *   never records an unconfirmed extraction — the ai-pass rule
 *   (AI proposes ops, user confirms) restated for money.
 *
 * Every extraction is attributable: { source: 'ocr', confidence,
 *   modelVersion } stored as metadata on the confirmed expense —
 *   so "the OCR misread ₦89,000 as ₦89,600" is debuggable months
 *   later, and prompt/model regressions are measurable per version
 *   (the AI-quality-channel rule). OCR cost is metered into the
 *   credit ledger like every AI feature; capture stays free,
 *   extraction counts.
 * ----------------------------------------------------------------
 */

// ───────────────────────────────────────────────
// Extraction result — propose, never write
// ───────────────────────────────────────────────

export interface OcrField<T> {
  /** The extracted value (null if not found). */
  readonly value: T | null;
  /** Confidence 0..1 (1 = very confident). */
  readonly confidence: number;
  /** Whether the confidence is above the confirmation threshold. */
  readonly aboveThreshold: boolean;
}

export interface OcrExtraction {
  readonly receiptHash: string;
  readonly merchant: OcrField<string>;
  readonly amount: OcrField<string>;
  readonly currency: OcrField<string>;
  readonly date: OcrField<number>;
  readonly taxLine: OcrField<string>;
  /** Attribution metadata for debugging + quality measurement. */
  readonly attribution: OcrAttribution;
}

export interface OcrAttribution {
  readonly source: "ocr";
  readonly modelVersion: string;
  readonly extractedAt: number;
  /** Cost in microcredits (metered into the credit ledger). */
  readonly costMicrocredits: number;
}

// ───────────────────────────────────────────────
// Confirmation threshold — fields below this are highlighted
// ───────────────────────────────────────────────

export const DEFAULT_CONFIRMATION_THRESHOLD = 0.85;

/**
 * Check if a field's confidence is above the confirmation threshold.
 * Fields below threshold are highlighted in the confirmation UI —
 * the user is prompted to double-check them before saving.
 */
export function isAboveThreshold(
  field: OcrField<unknown>,
  threshold: number = DEFAULT_CONFIRMATION_THRESHOLD,
): boolean {
  return field.confidence >= threshold;
}

/**
 * Build an OcrField with the threshold check applied.
 */
export function makeOcrField<T>(
  value: T | null,
  confidence: number,
  threshold: number = DEFAULT_CONFIRMATION_THRESHOLD,
): OcrField<T> {
  return {
    value,
    confidence,
    aboveThreshold: confidence >= threshold,
  };
}

// ───────────────────────────────────────────────
// Confirmation — the only path into the expense record
// ───────────────────────────────────────────────

/**
 * The confirmation result. The user reviews the OCR extraction,
 * edits any fields, then confirms. The confirmed values become
 * the expense record's fields.
 *
 * The system NEVER records an unconfirmed extraction. The AI
 * proposes; the user confirms. Same discipline as the AI op gate
 * in the security pass — AI output is a suggestion, not a fact.
 */
export interface OcrConfirmation {
  readonly receiptHash: string;
  /** Confirmed values (user-edited or accepted as-is). */
  readonly merchant: string;
  readonly amount: string;
  readonly currency: string;
  readonly date: number;
  readonly taxLine: string | null;
  /** Which fields were edited vs accepted as-is (for quality measurement). */
  readonly edits: ReadonlyArray<{
    field: "merchant" | "amount" | "currency" | "date" | "taxLine";
    ocrValue: string | number | null;
    confirmedValue: string | number;
  }>;
  /** The original extraction (for attribution — stored on the expense). */
  readonly extraction: OcrExtraction;
  readonly confirmedAt: number;
  readonly confirmedBy: string;
}

/**
 * Build a confirmation from an extraction + user edits. The user
 * can edit any field; the confirmation records which fields were
 * changed (for quality measurement — "how often does the OCR get
 * the amount wrong?").
 */
export function buildConfirmation(
  extraction: OcrExtraction,
  edits: {
    merchant?: string;
    amount?: string;
    currency?: string;
    date?: number;
    taxLine?: string | null;
  },
  confirmedBy: string,
  now: number = Date.now(),
): OcrConfirmation {
  const editLog: {
    field: "merchant" | "amount" | "currency" | "date" | "taxLine";
    ocrValue: string | number | null;
    confirmedValue: string | number;
  }[] = [];

  // Compare each field — record edits where the user changed the value.
  const merchant = edits.merchant ?? extraction.merchant.value ?? "";
  if (edits.merchant !== undefined && edits.merchant !== extraction.merchant.value) {
    editLog.push({ field: "merchant", ocrValue: extraction.merchant.value, confirmedValue: merchant });
  }

  const amount = edits.amount ?? extraction.amount.value ?? "";
  if (edits.amount !== undefined && edits.amount !== extraction.amount.value) {
    editLog.push({ field: "amount", ocrValue: extraction.amount.value, confirmedValue: amount });
  }

  const currency = edits.currency ?? extraction.currency.value ?? "NGN";
  if (edits.currency !== undefined && edits.currency !== extraction.currency.value) {
    editLog.push({ field: "currency", ocrValue: extraction.currency.value, confirmedValue: currency });
  }

  const date = edits.date ?? extraction.date.value ?? now;
  if (edits.date !== undefined && edits.date !== extraction.date.value) {
    editLog.push({ field: "date", ocrValue: extraction.date.value, confirmedValue: date });
  }

  const taxLine = edits.taxLine !== undefined ? edits.taxLine : (extraction.taxLine.value ?? null);
  if (edits.taxLine !== undefined && edits.taxLine !== extraction.taxLine.value) {
    editLog.push({ field: "taxLine", ocrValue: extraction.taxLine.value, confirmedValue: taxLine ?? "" });
  }

  return {
    receiptHash: extraction.receiptHash,
    merchant,
    amount,
    currency,
    date,
    taxLine,
    edits: editLog,
    extraction,
    confirmedAt: now,
    confirmedBy,
  };
}

// ───────────────────────────────────────────────
// Quality measurement — AI-quality channel bridge
// ───────────────────────────────────────────────

/**
 * Build a quality signal from a confirmation. Feeds the AI-quality
 * channel: edit rate per field = how often the OCR gets it wrong.
 * A model regression (more edits per field) is measurable per
 * version — the attribution metadata links back to the modelVersion.
 */
export interface OcrQualitySignal {
  readonly modelVersion: string;
  readonly receiptHash: string;
  /** Total fields extracted (5: merchant, amount, currency, date, taxLine). */
  readonly totalFields: number;
  /** Fields the user edited (lower = better OCR). */
  readonly editedFields: number;
  /** Edit rate (editedFields / totalFields). 0 = perfect, 1 = every field wrong. */
  readonly editRate: number;
  /** Per-field edit flags. */
  readonly fieldEdits: Readonly<Record<string, boolean>>;
  readonly extractedAt: number;
  readonly confirmedAt: number;
}

export function buildQualitySignal(confirmation: OcrConfirmation): OcrQualitySignal {
  const totalFields = 5; // merchant, amount, currency, date, taxLine
  const editedFields = confirmation.edits.length;
  const fieldEdits: Record<string, boolean> = {
    merchant: confirmation.edits.some((e) => e.field === "merchant"),
    amount: confirmation.edits.some((e) => e.field === "amount"),
    currency: confirmation.edits.some((e) => e.field === "currency"),
    date: confirmation.edits.some((e) => e.field === "date"),
    taxLine: confirmation.edits.some((e) => e.field === "taxLine"),
  };
  return {
    modelVersion: confirmation.extraction.attribution.modelVersion,
    receiptHash: confirmation.receiptHash,
    totalFields,
    editedFields,
    editRate: Math.round((editedFields / totalFields) * 1000) / 1000,
    fieldEdits,
    extractedAt: confirmation.extraction.attribution.extractedAt,
    confirmedAt: confirmation.confirmedAt,
  };
}

// ───────────────────────────────────────────────
// OCR service contract — capture free, extraction counts
// ───────────────────────────────────────────────

export interface OcrService {
  /**
   * Extract fields from a receipt image. Returns a proposal —
   * NEVER writes to the expense record. The caller presents the
   * proposal in the confirmation UI; the user confirms.
   *
   * Capture stays free (the mobile camera path doesn't call this);
   * extraction counts (metered into the credit ledger).
   */
  extract(receiptHash: string): Promise<OcrExtraction>;
}
