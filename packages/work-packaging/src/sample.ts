// A WorkSample is derived from a PAID milestone's deliverables.
// The gate is structural, like the review gate: no sample can
// exist without a completed-contract/milestone fact underneath
// it. A portfolio piece the freelancer never got paid for can
// still exist — but it's a manual upload, tagged unverified,
// and rendered with different (honest) provenance. Two tiers,
// clearly labeled:
//   verified:   minted from a paid milestone, carries contract ref
//   self_added: manual upload, "self-reported" badge, capped count

import { z } from "zod";
import { eq, and, desc, count } from "drizzle-orm";
import { db } from "@supa/db";
import { workSamples, milestones, contracts, activityFacts } from "@supa/db/schema";

// FIX: inlined helper (same pattern as all files in this monorepo).
async function recordActivity(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: { wsId: string; kind: string; ref: Record<string, unknown> },
): Promise<void> {
  await tx.insert(activityFacts).values({
    workspaceId: input.wsId,
    kind: input.kind,
    refId: JSON.stringify(input.ref),
    occurredAt: new Date(),
    actor: "system",
    source: "system",
  });
}

// ───────────────────────────────────────────────
// Enums
// ───────────────────────────────────────────────

export const SampleTier = z.enum(["verified", "self_added"]);

export const DeliverableKind = z.enum([
  "image", "document", "code_repo_ref", "link", "audio", "video",
]);

export const SampleVisibility = z.enum(["public", "link_only", "private"]);

// ───────────────────────────────────────────────
// WorkSample schema
// ───────────────────────────────────────────────

export const WorkSample = z.object({
  id: z.string().uuid(),
  wsId: z.string().uuid(),                  // freelancer's ws
  tier: SampleTier,
  milestoneFactId: z.string().uuid().nullable(),  // required when tier=verified — schema-enforced FK, like reviews
  title: z.string().min(1).max(140),
  narrative: z.string().max(5_000),         // freelancer's own words — the "how I approached it" layer
  deliverableRefs: z.array(z.object({
    attachmentId: z.string().uuid(),
    kind: DeliverableKind,
    redacted: z.boolean(),                  // client-confidential material scrubbed
  })).max(20),
  disciplines: z.array(z.string()).max(5),
  visibility: SampleVisibility,
  // FIX: added timestamps — every entity carries these.
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).refine(
  // Gate: tier=verified requires milestoneFactId (the structural FK gate).
  (sample) => sample.tier !== "verified" || sample.milestoneFactId !== null,
  { message: "verified samples require a milestoneFactId (FK to a paid milestone fact)" },
);

export type SampleTier = z.infer<typeof SampleTier>;
export type DeliverableKind = z.infer<typeof DeliverableKind>;
export type SampleVisibility = z.infer<typeof SampleVisibility>;
export type WorkSample = z.infer<typeof WorkSample>;

// ───────────────────────────────────────────────
// CLIENT CONFIDENTIALITY — the sprint's sharpest edge
// ───────────────────────────────────────────────
//
// Work a freelancer did under contract may be confidential. Rules:
//   1. Minting a verified sample requires the client's consent
//      fact OR full redaction (proof-of-work without the work:
//      blurred/striped previews, no client names, no repo URLs).
//   2. Consent is a fact on the contract timeline ("client
//      approved public display of X"), revocable — revocation
//      unpublishes the sample but keeps the history fact (the
//      no-delete rule applies here too; unpublish ≠ erase).
//   3. Disputed or cancelled contracts CANNOT mint samples.
//      Only "paid" milestones — the money is the proof.

// ───────────────────────────────────────────────
// Milestone shape for minting (the fields mint needs)
// ───────────────────────────────────────────────

export interface MintableMilestone {
  id: string;
  contractId: string;
  status: string;          // must be "paid"
  factId: string;          // FIX: the milestone's monetary fact id (the FK gate)
  contractStatus: string; // must be "completed" (not disputed/cancelled)
}

// ───────────────────────────────────────────────
// Consent fact — client approved public display
// ───────────────────────────────────────────────

export interface ConsentFact {
  contractId: string;
  kind: string;            // "supa.display_consent"
  grantedAt: string;
  revokedAt: string | null;
}

export function isConsentActive(consent: ConsentFact | null): boolean {
  if (!consent) return false;
  return consent.revokedAt === null;
}

/**
 * Check if all deliverables are redacted (no client-confidential
// material). Used when consent is NOT present — full redaction
// allows minting without consent (proof-of-work without the work).
 */
export function allRedacted(deliverableRefs: readonly { redacted: boolean }[]): boolean {
  return deliverableRefs.every((d) => d.redacted);
}

// ───────────────────────────────────────────────
// Row → domain mappers
// ───────────────────────────────────────────────
// The DB stores timestamps as Date; the wire/domain layer uses
// ISO strings (JSON can't carry Date, so the boundary is here).

type MilestoneRow = typeof milestones.$inferSelect;
type ContractRow = typeof contracts.$inferSelect;

function rowToMintable(m: MilestoneRow, c: ContractRow): MintableMilestone {
  if (m.milestoneFactId === null) {
    // Should be unreachable — callers gate on paidAt + milestoneFactId
    // before invoking this mapper, but the no-thin-air rule says the
    // factId gate is structural, so we assert here too.
    throw new Error(`milestone ${m.id} has no milestoneFactId — paid-fact gate missing`);
  }
  return {
    id: m.id,
    contractId: m.contractId,
    status: m.status,
    factId: m.milestoneFactId,
    contractStatus: c.status,
  };
}

// ───────────────────────────────────────────────
// fetchConsent — the latest display-consent fact on a contract
// ───────────────────────────────────────────────
//
// Consent is a fact on the contract timeline. The grant is one
// activity_fact (kind = "supa.display_consent"), the revocation
// is another (kind = "supa.display_consent.revoked"). refId is
// JSON-stringified, so we fetch all consent facts for the workspace
// and filter in JS for the contractId — the no-magic rule.
//
// A consent fact is "active" when there is a grant AND no later
// revocation for the same contract. The returned ConsentFact
// carries grantedAt (the latest grant) and revokedAt (the latest
// revocation strictly after the grant, or null).

async function fetchConsent(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  wsId: string,
  contractId: string,
): Promise<ConsentFact | null> {
  // Grants — most recent first.
  const grants = await tx.select().from(activityFacts)
    .where(and(
      eq(activityFacts.workspaceId, wsId),
      eq(activityFacts.kind, "supa.display_consent"),
    ))
    .orderBy(desc(activityFacts.occurredAt));

  const grant = grants.find((f) => f.refId?.includes(contractId) ?? false);
  if (!grant) return null;

  // Revocations — most recent first. Look for one strictly after the grant.
  const revokes = await tx.select().from(activityFacts)
    .where(and(
      eq(activityFacts.workspaceId, wsId),
      eq(activityFacts.kind, "supa.display_consent.revoked"),
    ))
    .orderBy(desc(activityFacts.occurredAt));

  const revoke = revokes.find((f) =>
    (f.refId?.includes(contractId) ?? false) && f.occurredAt > grant.occurredAt,
  );

  return {
    contractId,
    kind: "supa.display_consent",
    grantedAt: grant.occurredAt.toISOString(),
    revokedAt: revoke ? revoke.occurredAt.toISOString() : null,
  };
}

// ───────────────────────────────────────────────
// mintSample — mint a verified sample from a paid milestone
// ───────────────────────────────────────────────

export async function mintSample(
  wsId: string,
  milestoneId: string,
  input: Omit<WorkSample, "id" | "wsId" | "tier" | "milestoneFactId" | "createdAt" | "updatedAt">,
): Promise<WorkSample> {
  return db.transaction(async (tx) => {
    // Fetch the milestone row — the FK gate lives here (milestoneFactId).
    const [m] = await tx.select().from(milestones).where(eq(milestones.id, milestoneId));
    if (!m) throw new Error(`milestone ${milestoneId} not found`);

    // Fetch the contract row — needed for status + the workspace scope check.
    const [c] = await tx.select().from(contracts).where(eq(contracts.id, m.contractId));
    if (!c) throw new Error(`contract ${m.contractId} not found for milestone ${milestoneId}`);

    // Two-side tenancy: the freelancer (workspaceId) owns the contract
    // in the submit direction. The client could be authorized via
    // clientWsId in a richer handler; for the mint path, freelancer scope.
    if (c.freelancerWsId !== wsId) {
      throw new Error(
        `milestone ${milestoneId} belongs to contract ${m.contractId} not owned by workspace ${wsId}`,
      );
    }

    // Build the domain shape from real rows — no placeholder literals.
    const mintable = rowToMintable(m, c);

    // Gate 1: milestone must be paid — the money is the proof.
    if (mintable.status !== "paid") {
      throw new Error("only paid milestones mint samples");
    }

    // Gate 2: contract must be completed (not disputed/cancelled).
    if (mintable.contractStatus !== "completed") {
      throw new Error(`cannot mint sample from contract in status ${mintable.contractStatus} — disputed/cancelled contracts cannot mint`);
    }

    // Gate 3: consent OR full redaction. Query the real activity_facts
    // table for the latest display-consent grant on this contract.
    const consent = await fetchConsent(tx, wsId, mintable.contractId);

    if (!isConsentActive(consent) && !allRedacted(input.deliverableRefs)) {
      const unredacted = input.deliverableRefs.filter((d) => !d.redacted);
      throw new Error(
        `unredacted deliverables require client consent — ${String(unredacted.length)} deliverable(s) not redacted, no active consent fact`,
      );
    }

    const now = new Date().toISOString();
    const sample: WorkSample = WorkSample.parse({
      ...input,
      id: crypto.randomUUID(),
      wsId,
      tier: "verified",
      milestoneFactId: mintable.factId,   // FK gate — paid milestone's fact id
      createdAt: now,
      updatedAt: now,
    });

    // Persist the sample — INSERT into work_samples.
    await tx.insert(workSamples).values({
      id: sample.id,
      workspaceId: sample.wsId,
      tier: sample.tier,
      milestoneFactId: sample.milestoneFactId,
      title: sample.title,
      narrative: sample.narrative,
      deliverableRefs: sample.deliverableRefs,
      disciplines: sample.disciplines,
      visibility: sample.visibility,
      createdAt: new Date(sample.createdAt),
      updatedAt: new Date(sample.updatedAt),
    });

    await recordActivity(tx, {
      wsId,
      kind: "supa.sample.minted",
      ref: { sampleId: sample.id, milestoneId, contractId: mintable.contractId, tier: "verified" },
    });

    return sample;
  });
}

// ───────────────────────────────────────────────
// Self-added sample — manual upload, "self-reported" badge
// ───────────────────────────────────────────────

export const SELF_ADDED_CAP = 20; // capped count per freelancer

export async function createSelfAddedSample(
  wsId: string,
  input: Omit<WorkSample, "id" | "wsId" | "tier" | "milestoneFactId" | "createdAt" | "updatedAt">,
): Promise<WorkSample> {
  return db.transaction(async (tx) => {
    // Cap check: count existing self_added samples for this workspace.
    // No magic — a real count query, not a placeholder.
    const capRows = await tx.select({ value: count() }).from(workSamples)
      .where(and(
        eq(workSamples.workspaceId, wsId),
        eq(workSamples.tier, "self_added"),
      ));
    const current = capRows[0]?.value ?? 0;
    if (current >= SELF_ADDED_CAP) {
      throw new Error(`self-added sample cap reached (${String(current)}/${String(SELF_ADDED_CAP)})`);
    }

    const now = new Date().toISOString();
    const sample: WorkSample = WorkSample.parse({
      ...input,
      id: crypto.randomUUID(),
      wsId,
      tier: "self_added",
      milestoneFactId: null,  // self-added samples have no milestone FK
      createdAt: now,
      updatedAt: now,
    });

    // Persist the sample — INSERT into work_samples.
    await tx.insert(workSamples).values({
      id: sample.id,
      workspaceId: sample.wsId,
      tier: sample.tier,
      milestoneFactId: sample.milestoneFactId,
      title: sample.title,
      narrative: sample.narrative,
      deliverableRefs: sample.deliverableRefs,
      disciplines: sample.disciplines,
      visibility: sample.visibility,
      createdAt: new Date(sample.createdAt),
      updatedAt: new Date(sample.updatedAt),
    });

    await recordActivity(tx, {
      wsId,
      kind: "supa.sample.self_added",
      ref: { sampleId: sample.id, tier: "self_added" },
    });

    return sample;
  });
}

// ───────────────────────────────────────────────
// Consent revocation — unpublish ≠ erase
// ───────────────────────────────────────────────

/**
 * Revoke display consent for a contract's samples. Unpublishes
 * the samples (sets visibility to "private") but KEEPS the
 * history fact — the no-delete rule applies here too.
 *
 * "unpublish ≠ erase" — the sample record stays for audit;
 * it just becomes invisible to the public.
 */
export async function revokeConsent(
  wsId: string,
  contractId: string,
): Promise<void> {
  return db.transaction(async (tx) => {
    // Record the revocation as a fact on the contract timeline.
    await recordActivity(tx, {
      wsId,
      kind: "supa.display_consent.revoked",
      ref: { contractId },
    });

    // Unpublish all verified samples whose milestoneFactId belongs to a
    // milestone of this contract. Self-added samples are untouched (they
    // have milestoneFactId = null and are not gated by client consent).
    // The sample RECORD stays — only visibility changes.
    const contractMilestones = await tx.select().from(milestones)
      .where(eq(milestones.contractId, contractId));

    const now = new Date();
    for (const mst of contractMilestones) {
      if (mst.milestoneFactId === null) continue;
      await tx.update(workSamples)
        .set({ visibility: "private", updatedAt: now })
        .where(and(
          eq(workSamples.workspaceId, wsId),
          eq(workSamples.milestoneFactId, mst.milestoneFactId),
        ));
    }
  });
}
