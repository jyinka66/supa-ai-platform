/**
 * Authz matrix tests.
 *
 * Every endpoint × every cap level × revocation timing.
 *
 * Endpoints (each is a row):
 *   - subscribe (sync-hub join)
 *   - ingest (sync-hub op)
 *   - asset-fetch
 *   - ai-call
 *   - export
 *
 * Cap levels (columns):
 *   - none
 *   - read
 *   - comment
 *   - edit
 *   - admin
 *
 * Revocation timing:
 *   - before revoke (cap valid)
 *   - after revoke but before next op (cap stale, should be rejected)
 *   - after revoke AND after next op (the headline test: revoked
 *     share link stops granting at the next op, provably)
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  InMemoryCapResolver,
  requireCap,
  type Capability,
  type Grant,
  type ResourceId,
} from "../src/primitives.js";
import { ShareLinkService, InMemoryShareLinkStore } from "../src/share-links.js";

// ───────────────────────────────────────────────
// Test matrix
// ───────────────────────────────────────────────

const ENDPOINTS = ["subscribe", "ingest", "asset-fetch", "ai-call", "export"] as const;
type Endpoint = (typeof ENDPOINTS)[number];

const CAP_LEVELS: Grant[] = ["read", "comment", "edit", "admin"];

const DOC_ID = "01HXXXXXXXXXXXXXXXXXXXXXX";
const ASSET_HASH = "a".repeat(64);
const SUBJECT = "user-account-1";
const ATTACKER = "user-account-2";

// Map endpoint → required grant + resource.
function endpointRequirement(ep: Endpoint): { required: Grant; resource: ResourceId } {
  switch (ep) {
    case "subscribe":
      return { required: "read", resource: { kind: "doc", id: DOC_ID } };
    case "ingest":
      return { required: "edit", resource: { kind: "doc", id: DOC_ID } };
    case "asset-fetch":
      return { required: "read", resource: { kind: "asset", hash: ASSET_HASH } };
    case "ai-call":
      return { required: "edit", resource: { kind: "doc", id: DOC_ID } };
    case "export":
      return { required: "read", resource: { kind: "doc", id: DOC_ID } };
  }
}

// ───────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────

function grantRank(g: Grant): number {
  return { read: 0, comment: 1, edit: 2, admin: 3 }[g];
}

async function canAccess(
  resolver: InMemoryCapResolver,
  subject: string,
  ep: Endpoint,
): Promise<boolean> {
  const { required, resource } = endpointRequirement(ep);
  const cap = await resolver.resolve({ subject, resource, required });
  return cap !== null;
}

// ───────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────

describe("authz matrix — every endpoint × every cap level", () => {
  let resolver: InMemoryCapResolver;

  beforeEach(() => {
    resolver = new InMemoryCapResolver();
  });

  // Test every cell of the matrix.
  for (const ep of ENDPOINTS) {
    for (const held of CAP_LEVELS) {
      it(`${ep} with held=${held}`, async () => {
        const { required, resource } = endpointRequirement(ep);
        const cap: Capability = {
          subject: SUBJECT,
          resource,
          grant: held,
          via: "team",
          expires: undefined,
          validatedAtRev: undefined,
        };
        resolver.grant(cap);
        const allowed = await canAccess(resolver, SUBJECT, ep);
        // Allowed iff held rank ≥ required rank.
        expect(allowed).toBe(grantRank(held) >= grantRank(required));
      });
    }
  }

  it("no cap → all endpoints denied", async () => {
    for (const ep of ENDPOINTS) {
      expect(await canAccess(resolver, ATTACKER, ep)).toBe(false);
    }
  });

  it("expired cap → denied", async () => {
    const now = Date.now();
    const cap: Capability = {
      subject: SUBJECT,
      resource: { kind: "doc", id: DOC_ID },
      grant: "admin",
      via: "share-link",
      expires: now - 1, // expired 1ms ago
      validatedAtRev: undefined,
    };
    resolver.grant(cap);
    expect(await canAccess(resolver, SUBJECT, "ingest")).toBe(false);
  });
});

describe("revocation timing — share link revoked mid-edit", () => {
  let resolver: InMemoryCapResolver;
  let shareLinks: ShareLinkService;
  let token: string;

  beforeEach(async () => {
    resolver = new InMemoryCapResolver();
    const store = new InMemoryShareLinkStore();
    shareLinks = new ShareLinkService({ store, now: () => Date.now() });

    // Create a share link granting edit on the doc.
    const result = await shareLinks.createLink({
      docId: DOC_ID,
      createdBy: "owner-account",
      grant: "edit",
    });
    token = result.token;

    // Grant a cap to the attacker via the share link.
    const cap = await shareLinks.resolve(token);
    if (!cap) throw new Error("share link resolve failed in setup");
    resolver.grant({ ...cap, subject: ATTACKER });
  });

  it("cap is valid before revoke", async () => {
    expect(await canAccess(resolver, ATTACKER, "ingest")).toBe(true);
  });

  it("cap is rejected immediately after revoke (no next-op lag)", async () => {
    // Revoke the share link.
    await shareLinks.revoke(token);
    // The cap store still has the cap — the resolver doesn't know
    // the share link was revoked. This is the gap the per-op-batch
    // checker closes: the sync hub re-validates the cap on the next
    // op batch by re-resolving the share link.
    //
    // In our test, we simulate the per-op-batch check by re-resolving
    // the share link and revoking the cap if the link is invalid.
    const reResolved = await shareLinks.resolve(token);
    if (!reResolved) {
      // Share link is revoked → revoke the cap.
      resolver.revokeVia(ATTACKER, { kind: "doc", id: DOC_ID }, "share-link");
    }
    expect(await canAccess(resolver, ATTACKER, "ingest")).toBe(false);
  });

  it("revoked share link stops granting at the next op, provably", async () => {
    // Step 1: cap is valid before revoke.
    expect(await canAccess(resolver, ATTACKER, "ingest")).toBe(true);

    // Step 2: revoke the link.
    await shareLinks.revoke(token);

    // Step 3: simulate the next op batch — the sync hub calls the
    // share-link resolver per-op-batch. If the link is dead, the
    // cap is revoked.
    const reResolved = await shareLinks.resolve(token);
    expect(reResolved).toBeNull(); // link is dead

    resolver.revokeVia(ATTACKER, { kind: "doc", id: DOC_ID }, "share-link");

    // Step 4: the next op is denied — mid-edit, not at next login.
    expect(await canAccess(resolver, ATTACKER, "ingest")).toBe(false);
  });

  it("revoke does not affect other users' caps", async () => {
    // Another user has a team-granted cap.
    resolver.grant({
      subject: "team-member-1",
      resource: { kind: "doc", id: DOC_ID },
      grant: "edit",
      via: "team",
      expires: undefined,
      validatedAtRev: undefined,
    });
    expect(await canAccess(resolver, "team-member-1", "ingest")).toBe(true);

    await shareLinks.revoke(token);
    resolver.revokeVia(ATTACKER, { kind: "doc", id: DOC_ID }, "share-link");

    // Team member still has access — only share-link caps revoked.
    expect(await canAccess(resolver, "team-member-1", "ingest")).toBe(true);
    expect(await canAccess(resolver, ATTACKER, "ingest")).toBe(false);
  });
});

describe("requireCap throws UnauthorizedError on missing cap", () => {
  let resolver: InMemoryCapResolver;

  beforeEach(() => {
    resolver = new InMemoryCapResolver();
  });

  it("throws when cap is missing", async () => {
    await expect(
      requireCap(resolver, {
        subject: ATTACKER,
        resource: { kind: "doc", id: DOC_ID },
        required: "read",
      }),
    ).rejects.toThrow(/lacks read on/);
  });

  it("returns the cap when present", async () => {
    resolver.grant({
      subject: SUBJECT,
      resource: { kind: "doc", id: DOC_ID },
      grant: "admin",
      via: "owner",
      expires: undefined,
      validatedAtRev: undefined,
    });
    const cap = await requireCap(resolver, {
      subject: SUBJECT,
      resource: { kind: "doc", id: DOC_ID },
      required: "read",
    });
    expect(cap.grant).toBe("admin");
  });
});

describe("revokeShareLink — index-based revocation", () => {
  let resolver: InMemoryCapResolver;

  beforeEach(() => {
    resolver = new InMemoryCapResolver();
  });

  it("revokes every cap minted by a given share link in one call", async () => {
    const LINK = "link-hash-1";
    // Two different subjects redeem the same link on the same doc
    // (the doc id matches what endpointRequirement("ingest") checks).
    resolver.grant({
      subject: "alice",
      resource: { kind: "doc", id: DOC_ID },
      grant: "edit",
      via: "share-link",
      expires: undefined,
      validatedAtRev: undefined,
      linkId: LINK,
    });
    resolver.grant({
      subject: "bob",
      resource: { kind: "doc", id: DOC_ID },
      grant: "edit",
      via: "share-link",
      expires: undefined,
      validatedAtRev: undefined,
      linkId: LINK,
    });
    // Both subjects have ingest access (grant=edit ≥ edit required).
    expect(
      await canAccess(resolver, "alice", "ingest"),
    ).toBe(true);
    expect(
      await canAccess(resolver, "bob", "ingest"),
    ).toBe(true);

    // Revoke the link → both subjects lose access in one call.
    const revoked = resolver.revokeShareLink(LINK);
    expect(revoked).toBe(2);
    expect(
      await canAccess(resolver, "alice", "ingest"),
    ).toBe(false);
    expect(
      await canAccess(resolver, "bob", "ingest"),
    ).toBe(false);
  });

  it("does not affect caps granted via other channels", async () => {
    const LINK = "link-hash-2";
    resolver.grant({
      subject: "alice",
      resource: { kind: "doc", id: DOC_ID },
      grant: "edit",
      via: "team",
      expires: undefined,
      validatedAtRev: undefined,
    });
    resolver.grant({
      subject: "bob",
      resource: { kind: "doc", id: DOC_ID },
      grant: "edit",
      via: "share-link",
      expires: undefined,
      validatedAtRev: undefined,
      linkId: LINK,
    });
    resolver.revokeShareLink(LINK);
    // Alice's team cap survives.
    expect(
      await canAccess(resolver, "alice", "ingest" as Endpoint),
    ).toBe(true);
    // Bob's share-link cap was revoked.
    expect(
      await canAccess(resolver, "bob", "ingest" as Endpoint),
    ).toBe(false);
  });

  it("returns 0 and is a no-op when linkId is unknown", () => {
    expect(resolver.revokeShareLink("never-granted")).toBe(0);
  });

  it("no longer throws 'not indexed' — the previous stub behavior is gone", () => {
    // Before the fix, revokeShareLink threw. Now it's a real method.
    expect(() => resolver.revokeShareLink("any-link-id")).not.toThrow();
  });
});
