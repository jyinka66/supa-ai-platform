// The milestone payout path. Release is the sprint-3 money path —
// the state machine from sprint 2 is the gatekeeper, not this code.

import { db } from "@supa/db";
import {
  activityFacts,
  contracts,
  ledgerEntries,
  milestones,
} from "@supa/db/schema";
import { and, eq } from "drizzle-orm";
import { Money } from "@supa/freelance-core/job";
import {
  LedgerEntry,
  buildDoubleEntry,
  buildIdempotencyKey,
} from "./ledger.js";
import { assertTransition, type MilestoneStatus } from "@supa/supa-board/contract";

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

// FIX: PLATFORM_WS was undefined — the platform's own workspace for
// fee collection. In production this is a dedicated workspace; here
// it's a well-known UUID.
const PLATFORM_WS = "00000000-0000-0000-0000-000000000000";

// ───────────────────────────────────────────────
// Fee calculation — integer math, floor toward platform
// ───────────────────────────────────────────────

/**
 * Apply fee in basis points. Integer math, floor toward platform
 * (the platform rounds DOWN on its own cut — the freelancer gets
 * the remainder, which is the honest direction for rounding).
 *
 *   applyFeeBps(500_000, 100) = 5_000  (1% of 500k = 5k)
 *   applyFeeBps(500_001, 100) = 5_000  (floor — platform eats the 0.1)
 */
export function applyFeeBps(amountMinor: number, feeBps: number): number {
  return Math.floor((amountMinor * feeBps) / 10_000);
}

// ───────────────────────────────────────────────
// Money helpers — held / available are just Money constructors
// ───────────────────────────────────────────────

function held(amountMinor: number, currency: string): Money {
  return { amountMinor, currency };
}

function available(amountMinor: number, currency: string): Money {
  return { amountMinor, currency };
}

// ───────────────────────────────────────────────
// Contract shape for release (the fields release needs)
// ───────────────────────────────────────────────

export interface ReleaseContract {
  clientWsId: string;
  freelancerWsId: string;
  currency: string;
  feeBps: number;             // platform fee in basis points (e.g. 100 = 1%)
}

export interface ReleaseMilestone {
  id: string;
  contractId: string;
  amountMinor: number;
  status: MilestoneStatus;
}

// ───────────────────────────────────────────────
// releaseMilestone — three legs, one transaction, one idempotency family
// ───────────────────────────────────────────────

export async function releaseMilestone(
  wsId: string, milestoneId: string,
): Promise<void> {
  return db.transaction(async (tx) => {
    // Query the milestone by id. The milestones table has no
    // workspaceId column — tenancy is enforced via the contract
    // lookup below (the contract's workspaceId must match wsId).
    const [m] = await tx.select().from(milestones).where(eq(milestones.id, milestoneId));
    if (!m) throw new Error(`milestone ${milestoneId} not found`);

    // The transition is legal ONLY from "approved" — the state
    // machine from sprint 2 is the gatekeeper, not this code:
    assertTransition(m.status, "paid");

    // Query the contract — tenancy in the WHERE: the row must
    // belong to wsId. A third wsId simply finds no row.
    const [contract] = await tx.select().from(contracts).where(
      and(eq(contracts.id, m.contractId), eq(contracts.workspaceId, wsId)),
    );
    if (!contract) {
      throw new Error(`contract ${m.contractId} not found in workspace ${wsId}`);
    }

    // Drizzle returns bigint for amountMinor (mode: "bigint"); convert
    // to number for the integer math. feeBps is integer → number.
    const amountMinor = Number(m.amountMinor);
    const fee = applyFeeBps(amountMinor, contract.feeBps);
    const freelancerAmount = amountMinor - fee;

    // Pre-generate UUIDs for the contra linkage — debit ↔ credit
    // reference each other. Append-only ledger has no UPDATE, so we
    // can't fix up contraEntryId after the fact; pre-generate.
    const debitId = crypto.randomUUID();
    const creditId = crypto.randomUUID();
    const now = new Date();

    // Three legs, one transaction, one idempotency key family:

    // Leg 1: debit client's held account (escrow released FROM held)
    const [debitEntry] = await tx.insert(ledgerEntries).values({
      id: debitId,
      workspaceId: contract.clientWsId,
      type: "escrow_released",
      debitMinor: BigInt(amountMinor),
      debitCurrency: contract.currency,
      creditMinor: null,
      creditCurrency: null,
      contraEntryId: creditId,
      refType: "milestone",
      refId: milestoneId,
      idempotencyKey: `release:${milestoneId}:debit`,
      at: now,
    }).returning();

    // Leg 2: credit freelancer's available account (escrow released TO available)
    const [creditEntry] = await tx.insert(ledgerEntries).values({
      id: creditId,
      workspaceId: contract.freelancerWsId,
      type: "escrow_released",
      debitMinor: null,
      debitCurrency: null,
      creditMinor: BigInt(freelancerAmount),
      creditCurrency: contract.currency,
      contraEntryId: debitId,
      refType: "milestone",
      refId: milestoneId,
      idempotencyKey: `release:${milestoneId}:credit`,
      at: now,
    }).returning();

    // Leg 3: credit platform's revenue (fee collected)
    const [feeEntry] = await tx.insert(ledgerEntries).values({
      workspaceId: PLATFORM_WS,
      type: "fee_collected",
      debitMinor: null,
      debitCurrency: null,
      creditMinor: BigInt(fee),
      creditCurrency: contract.currency,
      contraEntryId: debitId,
      refType: "milestone",
      refId: milestoneId,
      idempotencyKey: `release:${milestoneId}:fee`,
      at: now,
    }).returning();

    // Sum invariant asserted inside the tx before commit:
    // debit === credit + fee, in minor units, exactly.
    // Verified against the RETURNING rows — the DB's view of what
    // was inserted, not just what we computed locally.
    const debitAmount = Number(debitEntry!.debitMinor);
    const creditAmount = Number(creditEntry!.creditMinor);
    const feeAmount = Number(feeEntry!.creditMinor);
    if (debitAmount !== creditAmount + feeAmount) {
      throw new Error(
        `SUM INVARIANT VIOLATION: debit (${debitAmount}) !== credit (${creditAmount}) + fee (${feeAmount})`,
      );
    }

    // Then — and only then — flip the milestone to "paid" and write
    // the fact. One tx, one idempotency family: ledger + state +
    // activity all commit together or none do.
    await tx.update(milestones).set({
      status: "paid",
      paidAt: now,
      updatedAt: now,
    }).where(eq(milestones.id, milestoneId));

    // FIX: "nova.milestone.paid" → "supa.milestone.paid"
    await recordActivity(tx, {
      wsId,
      kind: "supa.milestone.paid",
      ref: { contractId: m.contractId, milestoneId, fee },
    });
  });
}

// ───────────────────────────────────────────────
// Auto-release — client pre-authorizes "approve N days after submission"
// ───────────────────────────────────────────────

// Client auto-release option (the trust builder): client can
// pre-authorize "auto-approve N days after submission." Stored
// as a contract-level setting; the scheduler asserts the fact
// ("submitted > N days ago, still submitted") and calls the
// same releaseMilestone — one code path, not a parallel one.

export interface AutoReleaseSetting {
  contractId: string;
  autoReleaseDays: number;     // N days after submission
  enabled: boolean;
}

/**
 * Check if a milestone should auto-release. The scheduler calls
 * this; if true, it calls releaseMilestone — the SAME code path,
 * not a parallel one. One release path, whether triggered by
 * manual client approval or auto-release timer.
 */
export function shouldAutoRelease(
  milestoneSubmittedAt: number | null,
  setting: AutoReleaseSetting,
  now: number = Date.now(),
): boolean {
  if (!setting.enabled || !milestoneSubmittedAt) return false;
  const elapsedMs = now - milestoneSubmittedAt;
  const thresholdMs = setting.autoReleaseDays * 86_400_000;
  return elapsedMs >= thresholdMs;
}
