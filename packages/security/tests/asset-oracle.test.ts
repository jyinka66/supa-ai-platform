/**
 * Cross-account asset oracle test.
 *
 * Scenario: account B uploads identical bytes to account A's asset.
 * Assertions:
 *   - Dedupe behavior: same-account dedupes, cross-account stores twice.
 *   - No instant-success leak: dedupe hit takes ≥minUploadMs (DedupeOracleDefense).
 *   - Account B cannot fetch account A's hash (cap check denies).
 *   - "Upload succeeded instantly" must not imply "someone already
 *     had this file" — the dedupe oracle defense.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  InMemoryCapResolver,
  type Capability,
} from "../src/primitives.js";
import {
  authorizeAssetFetch,
  DedupeOracleDefense,
} from "../src/boundary-2-assets.js";

const ACCOUNT_A = "account-a";
const ACCOUNT_B = "account-b";
const ASSET_HASH = "a".repeat(64);
const ASSET_HASH_B = "b".repeat(64);

// ───────────────────────────────────────────────
// Stub asset store — tracks which accounts "have" which hashes
// ───────────────────────────────────────────────

class StubAssetStore {
  /** Map: assetHash → Set of accountIds that own it. */
  private readonly owners = new Map<string, Set<string>>();

  /** Returns true if the upload deduped (account already had this hash). */
  async upload(accountId: string, assetHash: string): Promise<{ deduped: boolean }> {
    let set = this.owners.get(assetHash);
    if (!set) {
      set = new Set();
      this.owners.set(assetHash, set);
    }
    const deduped = set.has(accountId);
    set.add(accountId);
    return { deduped };
  }

  has(accountId: string, assetHash: string): boolean {
    return this.owners.get(assetHash)?.has(accountId) ?? false;
  }
}

// ───────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────

describe("cross-account asset isolation", () => {
  let store: StubAssetStore;
  let resolver: InMemoryCapResolver;

  beforeEach(() => {
    store = new StubAssetStore();
    resolver = new InMemoryCapResolver();
  });

  it("account A uploads hash → owns it; account B cannot fetch", async () => {
    await store.upload(ACCOUNT_A, ASSET_HASH);

    // Account A has no cap granted to B.
    const bCanFetch = await authorizeAssetFetch(resolver, ACCOUNT_B, ASSET_HASH);
    expect(bCanFetch).toBe(false);

    // Account A also has no cap explicitly — but owns the asset.
    // In production the upload grants a cap on the asset to the
    // uploader. Simulate that here.
    const cap: Capability = {
      subject: ACCOUNT_A,
      resource: { kind: "asset", hash: ASSET_HASH },
      grant: "admin",
      via: "owner",
      expires: undefined,
      validatedAtRev: undefined,
    };
    resolver.grant(cap);

    const aCanFetch = await authorizeAssetFetch(resolver, ACCOUNT_A, ASSET_HASH);
    expect(aCanFetch).toBe(true);
  });

  it("account B uploads identical bytes → stored twice (cross-account dedupe is storage-only)", async () => {
    // A uploads first.
    await store.upload(ACCOUNT_A, ASSET_HASH);
    // B uploads the same hash.
    const bResult = await store.upload(ACCOUNT_B, ASSET_HASH);

    // B did not dedupe against A's asset — same-account dedupe only.
    expect(bResult.deduped).toBe(false);

    // Both accounts have their own link to the asset.
    expect(store.has(ACCOUNT_A, ASSET_HASH)).toBe(true);
    expect(store.has(ACCOUNT_B, ASSET_HASH)).toBe(true);
  });

  it("same-account re-upload dedupes", async () => {
    await store.upload(ACCOUNT_A, ASSET_HASH);
    const result = await store.upload(ACCOUNT_A, ASSET_HASH);
    expect(result.deduped).toBe(true);
  });
});

describe("dedupe oracle defense — 'instant success' must not leak", () => {
  let store: StubAssetStore;
  let defense: DedupeOracleDefense;

  beforeEach(() => {
    store = new StubAssetStore();
    // Use a small minUploadMs so the test runs fast.
    defense = new DedupeOracleDefense({ minUploadMs: 50 });
  });

  it("dedupe hit takes ≥ minUploadMs (no instant success leak)", async () => {
    // Pre-upload to create the dedupe hit.
    await store.upload(ACCOUNT_A, ASSET_HASH);

    // Second upload — should dedupe, but take ≥50ms.
    const start = Date.now();
    await defense.constantTimeUpload(async () => {
      return store.upload(ACCOUNT_A, ASSET_HASH);
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(45); // tolerance for timer slack
  });

  it("non-dedupe upload also takes ≥ minUploadMs (uniform timing)", async () => {
    // First upload — no dedupe hit, but still padded to ≥50ms.
    const start = Date.now();
    await defense.constantTimeUpload(async () => {
      return store.upload(ACCOUNT_A, ASSET_HASH_B);
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(45);
  });

  it("timing is uniform regardless of dedupe (attacker can't distinguish)", async () => {
    // Upload A first (no dedupe).
    const startA = Date.now();
    await defense.constantTimeUpload(async () => {
      return store.upload(ACCOUNT_A, ASSET_HASH);
    });
    const elapsedA = Date.now() - startA;

    // Upload A again (dedupe hit).
    const startB = Date.now();
    await defense.constantTimeUpload(async () => {
      return store.upload(ACCOUNT_A, ASSET_HASH);
    });
    const elapsedB = Date.now() - startB;

    // Both should be ≥ minUploadMs. The delta should be small
    // (within timer slack) — uniform timing.
    expect(elapsedA).toBeGreaterThanOrEqual(45);
    expect(elapsedB).toBeGreaterThanOrEqual(45);
    expect(Math.abs(elapsedA - elapsedB)).toBeLessThan(100); // generous slack
  });

  it("returns the upload result unchanged", async () => {
    const result = await defense.constantTimeUpload(async () => {
      return store.upload(ACCOUNT_A, ASSET_HASH);
    });
    expect(result).toEqual({ deduped: false });
  });
});

describe("cap check denies cross-account asset fetch", () => {
  let resolver: InMemoryCapResolver;

  beforeEach(() => {
    resolver = new InMemoryCapResolver();
    // Account A owns the asset.
    resolver.grant({
      subject: ACCOUNT_A,
      resource: { kind: "asset", hash: ASSET_HASH },
      grant: "admin",
      via: "owner",
      expires: undefined,
      validatedAtRev: undefined,
    });
  });

  it("account A can fetch own asset", async () => {
    expect(await authorizeAssetFetch(resolver, ACCOUNT_A, ASSET_HASH)).toBe(true);
  });

  it("account B cannot fetch A's asset (no cap)", async () => {
    expect(await authorizeAssetFetch(resolver, ACCOUNT_B, ASSET_HASH)).toBe(false);
  });

  it("account B can fetch A's asset if A grants a share-link cap", async () => {
    resolver.grant({
      subject: ACCOUNT_B,
      resource: { kind: "asset", hash: ASSET_HASH },
      grant: "read",
      via: "share-link",
      expires: undefined,
      validatedAtRev: undefined,
    });
    expect(await authorizeAssetFetch(resolver, ACCOUNT_B, ASSET_HASH)).toBe(true);
  });

  it("expired share-link cap denies fetch", async () => {
    const now = Date.now();
    resolver.grant({
      subject: ACCOUNT_B,
      resource: { kind: "asset", hash: ASSET_HASH },
      grant: "read",
      via: "share-link",
      expires: now - 1, // expired
      validatedAtRev: undefined,
    });
    expect(await authorizeAssetFetch(resolver, ACCOUNT_B, ASSET_HASH, now)).toBe(false);
  });

  it("hash enumeration is not an oracle — knowing the hash grants nothing", async () => {
    // Account B somehow learns A's asset hash but has no cap.
    // The fetch is denied regardless of whether the asset exists.
    expect(await authorizeAssetFetch(resolver, ACCOUNT_B, ASSET_HASH)).toBe(false);
    // Even a non-existent hash returns the same denial.
    expect(await authorizeAssetFetch(resolver, ACCOUNT_B, "0".repeat(64))).toBe(false);
  });
});
