/**
 * @supa/security/primitives
 * ----------------------------------------------------------------
 * Authz model: capabilities, not role checks scattered at endpoints.
 *
 *   cap = {
 *     subject: accountId,
 *     resource: docId | projectId | assetHash,
 *     grants:   'read' | 'comment' | 'edit' | 'admin',
 *     via:      'owner' | 'share-link' | 'team' | 'invite',
 *     expires?: number  // ms epoch; undefined = never
 *   }
 *
 * Every sync op, asset fetch, AI call, export job resolves a cap
 * first. The check is one function, one place — "does this account
 * hold a valid cap for this resource at this rev?" — and the sync
 * hub calls it per-op batch, not per-session. A revoked share link
 * revokes mid-edit at the next op, not at next login.
 * ----------------------------------------------------------------
 */

// ───────────────────────────────────────────────
// Capability primitives
// ───────────────────────────────────────────────

export type Grant = "read" | "comment" | "edit" | "admin";
export type CapVia = "owner" | "share-link" | "team" | "invite";

export type ResourceId =
  | { kind: "doc"; id: string }
  | { kind: "project"; id: string }
  | { kind: "asset"; hash: string };

/**
 * Immutable capability. Constructed only by the resolver — callers
 * never build caps directly, they ask the resolver whether one
 * exists for (subject, resource) at a given rev/time.
 */
export interface Capability {
  readonly subject: string; // accountId
  readonly resource: ResourceId;
  readonly grant: Grant;
  readonly via: CapVia;
  /** ms epoch; undefined = never expires. */
  readonly expires: number | undefined;
  /** Rev at which the cap was last re-validated (for doc resources). */
  readonly validatedAtRev: number | undefined;
  /**
   * For caps granted via a share link (`via === "share-link"`), the
   * link identifier (typically the link's `tokenHash`) that minted
   * this cap. Used by the resolver's link-id index so that
   * `revokeShareLink(linkId)` can find every subject who redeemed
   * the link and revoke their share-link caps in one call. Absent
   * for non-share-link caps and for legacy share-link caps that
   * pre-date this field.
   */
  readonly linkId?: string;
}

/**
 * Grant ordering — `read` < `comment` < `edit` < `admin`.
 * A cap with grant=admin satisfies a request for grant=read.
 */
const GRANT_RANK: Record<Grant, number> = {
  read: 0,
  comment: 1,
  edit: 2,
  admin: 3,
};

export function grantSatisfies(held: Grant, required: Grant): boolean {
  return GRANT_RANK[held] >= GRANT_RANK[required];
}

// ───────────────────────────────────────────────
// Capability resolver — single point of authority
// ───────────────────────────────────────────────

export interface CapResolveQuery {
  subject: string;
  resource: ResourceId;
  required: Grant;
  /** For doc resources: the current rev (so expiry can be rev-based). */
  atRev?: number;
  /** Wall clock at the check. Defaults to Date.now(). */
  now?: number;
}

export interface CapResolver {
  /**
   * THE function. Returns the cap if the subject holds a valid one
   * for the resource at the rev/time, else null. Callers never
   * branch on grant strength — they ask for what they need and the
   * resolver returns the cap if satisfied.
   */
  resolve(query: CapResolveQuery): Promise<Capability | null>;
}

// ───────────────────────────────────────────────
// In-memory resolver (tests + local dev)
// ───────────────────────────────────────────────

/**
 * The in-memory resolver stores caps in a Map keyed by
 * `${subject}|${resource.kind}:${id}`. Real implementations store
 * caps in the RDBMS (small + boring) with redis-cached hot lookups.
 *
 * The contract is the same — the resolver is the only path.
 */
function sameResource(a: ResourceId, b: ResourceId): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "asset" && b.kind === "asset") return a.hash === b.hash;
  // Both are doc or project — both have `id`.
  return (a as { id: string }).id === (b as { id: string }).id;
}

export class InMemoryCapResolver implements CapResolver {
  private readonly caps = new Map<string, Capability[]>();
  /**
   * Index of share-link grants: linkId → list of (subject, resource)
   * pairs that redeemed that link. Populated when a cap with
   * `via === "share-link"` and a non-empty `linkId` is granted, so
   * `revokeShareLink(linkId)` can revoke every cap minted by that
   * link in a single call instead of throwing "not indexed".
   */
  private readonly linkIdToSubjects = new Map<
    string,
    Array<{ subject: string; resource: ResourceId }>
  >();

  /** Called by the owner/share-link/team code paths to grant a cap. */
  grant(cap: Capability): void {
    const key = this.key(cap.subject, cap.resource);
    const list = this.caps.get(key) ?? [];
    // Replace any existing cap for the same via. If the cap being
    // replaced was a share-link cap minted by a different linkId,
    // drop its stale index entry so the old link no longer points
    // at a (subject, resource) it no longer authorizes.
    const filtered = list.filter((c) => {
      if (c.via !== cap.via) return true;
      if (c.via === "share-link" && c.linkId) {
        this.linkIndexRemove(c.linkId, c.subject, c.resource);
      }
      return false;
    });
    filtered.push(cap);
    this.caps.set(key, filtered);
    // Index the new share-link cap so revokeShareLink can find it.
    if (cap.via === "share-link" && cap.linkId) {
      this.linkIndexAdd(cap.linkId, cap.subject, cap.resource);
    }
  }

  /** Revoke all caps for a subject on a resource (e.g., leave team). */
  revokeAll(subject: string, resource: ResourceId): void {
    const key = this.key(subject, resource);
    const list = this.caps.get(key);
    if (list) {
      // Clean up share-link index entries for any caps being dropped.
      for (const c of list) {
        if (c.via === "share-link" && c.linkId) {
          this.linkIndexRemove(c.linkId, c.subject, c.resource);
        }
      }
    }
    this.caps.delete(key);
  }

  /** Revoke caps granted via a specific channel (e.g., share-link revoked). */
  revokeVia(subject: string, resource: ResourceId, via: CapVia): void {
    const key = this.key(subject, resource);
    const list = this.caps.get(key);
    if (!list) return;
    const filtered = list.filter((c) => {
      if (c.via !== via) return true;
      if (c.via === "share-link" && c.linkId) {
        this.linkIndexRemove(c.linkId, c.subject, c.resource);
      }
      return false;
    });
    if (filtered.length === 0) {
      this.caps.delete(key);
    } else {
      this.caps.set(key, filtered);
    }
  }

  /**
   * Revoke every cap minted by a given share link. Looks up the
   * link-id index and calls `revokeVia(..., "share-link")` for each
   * (subject, resource) that redeemed the link. Caps that were
   * granted via other channels (team, owner) are untouched.
   *
   * Returns the number of (subject, resource) pairs that had their
   * share-link caps revoked — useful for telemetry and tests.
   */
  revokeShareLink(linkId: string): number {
    const entries = this.linkIdToSubjects.get(linkId);
    if (!entries || entries.length === 0) return 0;
    // Snapshot to avoid mutation during iteration (revokeVia cleans
    // up the index, which would mutate the array we're walking).
    const snapshot = entries.slice();
    let revoked = 0;
    for (const { subject, resource } of snapshot) {
      this.revokeVia(subject, resource, "share-link");
      revoked++;
    }
    // revokeVia should have emptied the array; delete defensively.
    this.linkIdToSubjects.delete(linkId);
    return revoked;
  }

  async resolve(query: CapResolveQuery): Promise<Capability | null> {
    const key = this.key(query.subject, query.resource);
    const list = this.caps.get(key);
    if (!list || list.length === 0) return null;
    const now = query.now ?? Date.now();
    // Find the strongest cap that satisfies the required grant and
    // hasn't expired (by time or by rev).
    let best: Capability | null = null;
    for (const cap of list) {
      if (!grantSatisfies(cap.grant, query.required)) continue;
      if (cap.expires !== undefined && cap.expires <= now) continue;
      // Rev-based expiry: if the cap was validated at rev N and the
      // share-link has since been revoked at rev M > N, the cap is
      // stale. The resolver doesn't know the revoke-rev directly —
      // it relies on the cap store having pruned stale caps. The
      // `validatedAtRev` is a hint for the caller's telemetry, not
      // a security check (the cap store is the source of truth).
      if (best === null || GRANT_RANK[cap.grant] > GRANT_RANK[best.grant]) {
        best = cap;
      }
    }
    return best;
  }

  private key(subject: string, resource: ResourceId): string {
    const r = resource.kind === "asset" ? `asset:${resource.hash}` : `${resource.kind}:${resource.id}`;
    return `${subject}|${r}`;
  }

  /** Add a (subject, resource) entry to the link-id index. */
  private linkIndexAdd(
    linkId: string,
    subject: string,
    resource: ResourceId,
  ): void {
    const arr = this.linkIdToSubjects.get(linkId) ?? [];
    // The cap model guarantees one share-link cap per (subject, resource),
    // so the entry should already be unique — guard against duplicates anyway.
    if (!arr.some((e) => e.subject === subject && sameResource(e.resource, resource))) {
      arr.push({ subject, resource });
    }
    this.linkIdToSubjects.set(linkId, arr);
  }

  /** Remove a (subject, resource) entry from the link-id index. */
  private linkIndexRemove(
    linkId: string,
    subject: string,
    resource: ResourceId,
  ): void {
    const arr = this.linkIdToSubjects.get(linkId);
    if (!arr) return;
    const idx = arr.findIndex(
      (e) => e.subject === subject && sameResource(e.resource, resource),
    );
    if (idx < 0) return;
    arr.splice(idx, 1);
    if (arr.length === 0) {
      this.linkIdToSubjects.delete(linkId);
    } else {
      this.linkIdToSubjects.set(linkId, arr);
    }
  }
}

// ───────────────────────────────────────────────
// Errors
// ───────────────────────────────────────────────

export class UnauthorizedError extends Error {
  constructor(
    message: string,
    readonly subject: string,
    readonly resource: ResourceId,
    readonly required: Grant,
  ) {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/**
 * Convenience: throw if the subject lacks the required grant.
 * Callers pass the resolver + query; this is the single function
 * used by all routes — sync hub, asset fetch, AI gateway, export job.
 */
export async function requireCap(
  resolver: CapResolver,
  query: CapResolveQuery,
): Promise<Capability> {
  const cap = await resolver.resolve(query);
  if (!cap) {
    throw new UnauthorizedError(
      `subject ${query.subject} lacks ${query.required} on ${JSON.stringify(query.resource)}`,
      query.subject,
      query.resource,
      query.required,
    );
  }
  return cap;
}
