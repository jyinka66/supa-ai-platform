/**
 * ReceiptRepository — the real DB implementation.
 *
 * Content-addressed: the receipt bytes are SHA-256 hashed, the hash
 * is the key. Same bytes → same hash → stored once. A merchant's
 * receipt photo attached to two expenses is one blob.
 *
 * For now this uses the in-memory store from @supa/expenses/receipts
 * (tests + local dev). Production swaps in S3/MinIO with the same
 * content hash as the key — the ReceiptRepository contract doesn't
 * change.
 *
 * EXIF stripping + image-bomb defense belong in the decode-reencode
 * pipeline (the security pass) before upload. This repository trusts
 * that the caller has run that pipeline and asserts the bytes are
 * valid (size cap + MIME allowlist) before storing.
 */

import {
  validateReceipt,
  InMemoryReceiptStore,
  type ReceiptRepository as IReceiptRepository,
} from "@supa/expenses/receipts";

export class ReceiptRepositoryImpl implements IReceiptRepository {
  // In-memory store. Production: S3/MinIO adapter with the same
  // content-hash key (the ReceiptStore interface is the seam).
  private readonly store = new InMemoryReceiptStore();

  async upload(bytes: Uint8Array, mimeType: string): Promise<{ hash: string }> {
    // Validate (file size + MIME allowlist). The hash is computed
    // here too — same bytes → same hash → idempotent store.
    const result = validateReceipt(bytes, mimeType);
    if (!result.ok) {
      throw new Error(`receipt validation failed: ${result.reason}`);
    }
    // store() is idempotent — same bytes hashed once, stored once.
    const hash = await this.store.store(bytes);
    return { hash };
  }

  async fetch(hash: string): Promise<Uint8Array | null> {
    return this.store.fetch(hash);
  }

  async exists(hash: string): Promise<boolean> {
    return this.store.exists(hash);
  }
}
