/**
 * @supa/security/share-links
 * ----------------------------------------------------------------
 * Share links: /s/:token where token = 128-bit random, hashed at
 * rest (lookup by hash; a DB dump doesn't leak working links),
 * optional password, optional expiry, revocable. Link scope is
 * per-doc, never per-project — blast radius of a leaked link is
 * one document.
 * ----------------------------------------------------------------
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Capability, CapVia, Grant, ResourceId } from "./primitives.js";

// ───────────────────────────────────────────────
// Token shape
// ───────────────────────────────────────────────

/**
 * Token = 128-bit random, base64url-encoded (22 chars). Never stored
 * in plaintext server-side — only the SHA-256 hash is persisted.
 *
 * The token is presented to the client ONCE at creation; subsequent
 * lookups use the hash. A DB dump leaks hashes (useless without the
 * preimage) but not working links.
 */
export const TOKEN_BYTES = 16; // 128 bits
export const TOKEN_ENCODING: BufferEncoding = "base64url";

export function generateShareToken(): string {
  return randomBytes(TOKEN_BYTES).toString(TOKEN_ENCODING);
}

/**
 * Hash a token for at-rest storage. SHA-256 is sufficient — tokens
 * are 128-bit random, so brute force is infeasible and rainbow tables
 * don't help (the keyspace is the same as the hash keyspace).
 */
export function hashShareToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ───────────────────────────────────────────────
// Share link record (at-rest shape)
// ───────────────────────────────────────────────

export interface ShareLinkRecord {
  /** SHA-256 of the token — the primary key. */
  readonly tokenHash: string;
  /** Doc the link grants access to. NEVER a project id. */
  readonly docId: string;
  /** Account that created the link. */
  readonly createdBy: string;
  /** Grant strength the link confers. */
  readonly grant: Grant;
  /** Optional password hash (argon2id in prod; sha-256 in tests). */
  readonly passwordHash: string | null;
  /** Optional expiry (ms epoch). */
  readonly expiresAt: number | null;
  /** When the link was created. */
  readonly createdAt: number;
  /** When the link was revoked (null = active). */
  readonly revokedAt: number | null;
  /** Optional rev at which the link was last re-validated. */
  readonly lastRev: number | null;
}

// ───────────────────────────────────────────────
// Store interface
// ───────────────────────────────────────────────

export interface ShareLinkStore {
  /** Insert a new link. Throws on collision (tokenHash unique). */
  insert(record: ShareLinkRecord): Promise<void>;
  /** Look up by token hash. Returns null if not found or revoked. */
  findByHash(tokenHash: string): Promise<ShareLinkRecord | null>;
  /** Mark a link as revoked. Idempotent. */
  revoke(tokenHash: string, now: number): Promise<void>;
  /** Revoke all links for a doc (e.g., doc deleted). */
  revokeAllForDoc(docId: string, now: number): Promise<void>;
}

// ───────────────────────────────────────────────
// Password verification (timing-safe)
// ───────────────────────────────────────────────

export function verifyPassword(
  presented: string,
  storedHash: string | null,
): boolean {
  if (storedHash === null) return true; // no password required
  const presentedHash = createHash("sha256").update(presented).digest("hex");
  // timingSafeEqual requires equal-length buffers.
  const a = Buffer.from(presentedHash, "hex");
  const b = Buffer.from(storedHash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ───────────────────────────────────────────────
// Share link service
// ───────────────────────────────────────────────

export interface ShareLinkServiceOptions {
  store: ShareLinkStore;
  /** Override clock (tests). */
  now?: () => number;
  /** Optional: cap resolver to grant caps when a link is used. */
  onCapGranted?: (cap: Capability) => void;
}

export class ShareLinkService {
  private readonly store: ShareLinkStore;
  private readonly now: () => number;
  private readonly onCapGranted: ShareLinkServiceOptions["onCapGranted"];

  constructor(opts: ShareLinkServiceOptions) {
    this.store = opts.store;
    this.now = opts.now ?? Date.now;
    this.onCapGranted = opts.onCapGranted ?? (() => {});
  }

  /**
   * Create a share link. Returns the plaintext token (shown to the
   * creator once) — the server stores only the hash.
   *
   * Scope is per-doc, never per-project. The caller passes a docId;
   * we refuse project-scoped resources at this layer.
   */
  async createLink(params: {
    docId: string;
    createdBy: string;
    grant: Grant;
    password?: string;
    expiresAt?: number;
  }): Promise<{ token: string; record: ShareLinkRecord }> {
    if (!params.docId) {
      throw new Error("share link scope must be a docId, never a project");
    }
    const token = generateShareToken();
    const tokenHash = hashShareToken(token);
    const passwordHash = params.password
      ? createHash("sha256").update(params.password).digest("hex")
      : null;
    const record: ShareLinkRecord = {
      tokenHash,
      docId: params.docId,
      createdBy: params.createdBy,
      grant: params.grant,
      passwordHash,
      expiresAt: params.expiresAt ?? null,
      createdAt: this.now(),
      revokedAt: null,
      lastRev: null,
    };
    await this.store.insert(record);
    return { token, record };
  }

  /**
   * Resolve a presented token to a capability. This is called by the
   * share-link redemption route and by the sync hub when a client
   * joins via /s/:token.
   *
   * Returns the cap if valid, else null. Never throws on invalid
   * token — always returns null, so an attacker can't distinguish
   * "wrong token" from "expired" from "revoked".
   */
  async resolve(token: string, password?: string): Promise<Capability | null> {
    const tokenHash = hashShareToken(token);
    const record = await this.store.findByHash(tokenHash);
    if (!record) return null;
    if (record.revokedAt !== null) return null;
    if (record.expiresAt !== null && record.expiresAt <= this.now()) return null;
    if (record.passwordHash !== null) {
      if (!password) return null;
      if (!verifyPassword(password, record.passwordHash)) return null;
    }
    const cap: Capability = {
      subject: "", // filled in by caller (the account that redeemed)
      resource: { kind: "doc", id: record.docId },
      grant: record.grant,
      via: "share-link" satisfies CapVia,
      expires: record.expiresAt ?? undefined,
      validatedAtRev: record.lastRev ?? undefined,
      // Tag the cap with the link's tokenHash so the resolver can
      // revoke every cap minted by this link in one call via
      // `revokeShareLink(tokenHash)`.
      linkId: record.tokenHash,
    };
    this.onCapGranted?.(cap);
    return cap;
  }

  /** Revoke a link by its plaintext token. */
  async revoke(token: string): Promise<void> {
    const tokenHash = hashShareToken(token);
    await this.store.revoke(tokenHash, this.now());
  }

  /** Revoke all links for a doc (called on doc delete). */
  async revokeAllForDoc(docId: string): Promise<void> {
    await this.store.revokeAllForDoc(docId, this.now());
  }
}

// ───────────────────────────────────────────────
// In-memory store (tests + local dev)
// ───────────────────────────────────────────────

export class InMemoryShareLinkStore implements ShareLinkStore {
  private readonly records = new Map<string, ShareLinkRecord>();

  async insert(record: ShareLinkRecord): Promise<void> {
    if (this.records.has(record.tokenHash)) {
      throw new Error(`token collision (astronomically unlikely): ${record.tokenHash}`);
    }
    this.records.set(record.tokenHash, record);
  }

  async findByHash(tokenHash: string): Promise<ShareLinkRecord | null> {
    return this.records.get(tokenHash) ?? null;
  }

  async revoke(tokenHash: string, now: number): Promise<void> {
    const rec = this.records.get(tokenHash);
    if (!rec) return;
    if (rec.revokedAt !== null) return; // idempotent
    this.records.set(tokenHash, { ...rec, revokedAt: now });
  }

  async revokeAllForDoc(docId: string, now: number): Promise<void> {
    for (const [hash, rec] of this.records) {
      if (rec.docId === docId && rec.revokedAt === null) {
        this.records.set(hash, { ...rec, revokedAt: now });
      }
    }
  }
}
