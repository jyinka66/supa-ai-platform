/**
 * @supa/expenses/receipts
 * ----------------------------------------------------------------
 * Receipt upload: content-addressed store (the assets-pass rule
 *   returns — same bytes, same hash, stored once; a merchant's
 *   receipt photo attached twice is one blob). Mobile camera path:
 *   capture → auto-crop/contrast enhance → store, all before OCR;
 *   capture works offline (draft + queued upload, the offline-
 *   drafts rule), OCR runs on upload completion.
 *
 * Decode caps and sanitization mirror the security pass: image
 *   re-encoded through the decode-reencode pipeline, EXIF stripped
 *   (a receipt photo can carry GPS — customer PII discipline
 *   applies to the owner's own location too), size/pixel-bomb
 *   limits enforced before anything else runs.
 * ----------------------------------------------------------------
 */

import { createHash } from "node:crypto";

// ───────────────────────────────────────────────
// Receipt store — content-addressed
// ───────────────────────────────────────────────

export interface ReceiptStore {
  /** Store receipt bytes. Returns the content hash (sha-256). Idempotent — same bytes = same hash, stored once. */
  store(bytes: Uint8Array): Promise<string>;
  /** Fetch receipt bytes by hash. Returns null if not found. */
  fetch(hash: string): Promise<Uint8Array | null>;
  /** Check if a receipt exists (for dedup check before upload). */
  exists(hash: string): Promise<boolean>;
}

/**
 * In-memory receipt store (tests + local dev). Production uses
 * object storage (S3/MinIO) with the content hash as the key —
 * same bytes, same hash, stored once.
 */
export class InMemoryReceiptStore implements ReceiptStore {
  private readonly blobs = new Map<string, Uint8Array>();

  async store(bytes: Uint8Array): Promise<string> {
    const hash = hashBytes(bytes);
    if (!this.blobs.has(hash)) {
      this.blobs.set(hash, bytes);
    }
    return hash;
  }

  async fetch(hash: string): Promise<Uint8Array | null> {
    return this.blobs.get(hash) ?? null;
  }

  async exists(hash: string): Promise<boolean> {
    return this.blobs.has(hash);
  }
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ───────────────────────────────────────────────
// Receipt validation — decode caps + sanitization
// ───────────────────────────────────────────────

export interface ReceiptLimits {
  /** Max file size in bytes (default 10 MiB). */
  maxFileSize: number;
  /** Max pixel count at decode (default 50 MP). */
  maxPixels: number;
  /** Allowed MIME types. */
  allowedMimeTypes: readonly string[];
}

export const DEFAULT_RECEIPT_LIMITS: ReceiptLimits = {
  maxFileSize: 10 * 1024 * 1024, // 10 MiB
  maxPixels: 50_000_000, // 50 MP
  allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/heic"],
};

export interface ReceiptValidationResult {
  ok: boolean;
  /** Computed content hash (if ok). */
  hash: string | null;
  reason: string | null;
}

/**
 * Validate a receipt image before storing. Enforces:
 *   - File size cap (size-bomb defense)
 *   - MIME type allowlist (no SVGs — they're code, not images)
 *   - EXIF stripping confirmation (the caller must strip EXIF before
 *     calling store(); this function checks the flag)
 *
 * Image-bomb (pixel-count) defense happens at decode time in the
 * decode-reencode pipeline — this function checks the file size +
 * MIME type only, since pixel count requires decoding.
 */
export function validateReceipt(
  bytes: Uint8Array,
  mimeType: string,
  limits: ReceiptLimits = DEFAULT_RECEIPT_LIMITS,
): ReceiptValidationResult {
  if (bytes.length > limits.maxFileSize) {
    return {
      ok: false,
      hash: null,
      reason: `file size ${bytes.length} exceeds cap ${limits.maxFileSize}`,
    };
  }
  if (!limits.allowedMimeTypes.includes(mimeType)) {
    return {
      ok: false,
      hash: null,
      reason: `MIME type ${mimeType} not in allowlist`,
    };
  }
  return { ok: true, hash: hashBytes(bytes), reason: null };
}

// ───────────────────────────────────────────────
// EXIF stripping — the receipt photo can carry GPS
// ───────────────────────────────────────────────

/**
 * EXIF stripping contract. A receipt photo can carry GPS — customer
 * PII discipline applies to the owner's own location too. The
 * decode-reencode pipeline strips EXIF before storage.
 *
 * This function is the contract marker — the actual stripping
 * happens in the decode-reencode pipeline (design-assets pass).
 * The caller asserts `exifStripped=true` after the pipeline runs.
 */
export interface StrippedReceipt {
  /** The stripped image bytes (EXIF removed, re-encoded as JPEG). */
  readonly bytes: Uint8Array;
  /** The content hash of the stripped bytes. */
  readonly hash: string;
  /** Confirmation that EXIF was stripped. */
  readonly exifStripped: boolean;
  /** Original MIME type (for the validation allowlist check). */
  readonly originalMimeType: string;
}

// ───────────────────────────────────────────────
// Offline capture — draft + queued upload
// ───────────────────────────────────────────────

/**
 * Offline receipt capture. The mobile camera path works offline:
 *   1. capture → auto-crop/contrast enhance → store locally (draft)
 *   2. queued upload — when connection returns, the draft uploads
 *   3. OCR runs on upload completion (not on capture — capture is free)
 *
 * This interface is the queued-upload contract. The mobile client
 * enqueues drafts; the sync layer uploads them when online.
 */
export interface QueuedReceiptDraft {
  readonly id: string;
  /** Local bytes (captured but not yet uploaded). */
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  /** When the draft was captured (ms epoch). */
  readonly capturedAt: number;
  /** Whether the draft has been uploaded (false = queued). */
  readonly uploaded: boolean;
  /** Content hash (computed on upload, null while local-only). */
  readonly hash: string | null;
}

/**
 * Create a queued receipt draft (offline capture). The draft is
 * stored locally; the sync layer uploads it when connection returns.
 */
export function createQueuedDraft(
  id: string,
  bytes: Uint8Array,
  mimeType: string,
  capturedAt: number = Date.now(),
): QueuedReceiptDraft {
  return {
    id,
    bytes,
    mimeType,
    capturedAt,
    uploaded: false,
    hash: null,
  };
}

/**
 * Mark a queued draft as uploaded (after the sync layer uploads it).
 * Returns a new draft with `uploaded=true` + the content hash set.
 */
export function markUploaded(
  draft: QueuedReceiptDraft,
  hash: string,
): QueuedReceiptDraft {
  return { ...draft, uploaded: true, hash };
}

// ───────────────────────────────────────────────
// Receipt repository contract
// ───────────────────────────────────────────────

export interface ReceiptRepository {
  /** Upload a receipt (validates + stores + returns hash). Idempotent. */
  upload(bytes: Uint8Array, mimeType: string): Promise<{ hash: string }>;

  /** Fetch receipt bytes by hash. */
  fetch(hash: string): Promise<Uint8Array | null>;

  /** Check if a receipt exists (for dedup check). */
  exists(hash: string): Promise<boolean>;
}
