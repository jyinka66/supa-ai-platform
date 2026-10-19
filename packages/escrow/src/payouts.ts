// Money leaving the building. Freelancer "available" balance →
// real bank transfer.

import { z } from "zod";
import { db } from "@supa/db";
import { activityFacts, ledgerEntries, payouts } from "@supa/db/schema";
import { and, eq } from "drizzle-orm";
import {
  LedgerEntry,
  computeBalance,
} from "./ledger.js";

// FIX: inlined helper (same pattern as all files).
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
// Payout status — state machine
// ───────────────────────────────────────────────

export const PayoutStatus = z.enum([
  "in_transit",    // provider pending
  "confirmed",     // provider ack — money left the building
  "failed",        // provider rejected — reversal entry written, money back to available
]);

export type PayoutStatus = z.infer<typeof PayoutStatus>;

// ───────────────────────────────────────────────
// Payout entity
// ───────────────────────────────────────────────

export const Payout = z.object({
  id: z.string().uuid(),
  wsId: z.string().uuid(),
  amountMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
  status: PayoutStatus,
  // The idempotency key family — shared across ledger entries + provider call.
  // Provider's idempotency support + our ledger key = at-most-once money movement.
  key: z.string(),
  // Provider reference (e.g. transfer id from the bank API).
  providerRef: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Payout = z.infer<typeof Payout>;

// ───────────────────────────────────────────────
// Errors
// ───────────────────────────────────────────────

export class InsufficientFunds extends Error {
  constructor(
    readonly wsId: string,
    readonly currency: string,
    readonly requested: number,
    readonly available: number,
  ) {
    super(`insufficient funds: requested ${String(requested)} ${currency}, available ${String(available)}`);
    this.name = "InsufficientFunds";
  }
}

// ───────────────────────────────────────────────
// requestPayout — available balance → bank transfer
// ───────────────────────────────────────────────

export async function requestPayout(
  wsId: string,
  amountMinor: number,
  currency: string,
): Promise<Payout> {
  // The payout UUID is generated up-front so the ledger entry can
  // reference it as refId (the schema requires a UUID, not the
  // human-readable idempotency key).
  const payoutId = crypto.randomUUID();
  const key = `payout:${payoutId}`;
  const now = new Date();

  return db.transaction(async (tx) => {
    // Balance is DERIVED from ledger entries (computeBalance —
    // the no-drift rule). Query the workspace's ledger entries and
    // compute the available balance inside the tx. The tx isolation
    // level prevents races — no negative balance, ever.
    const rows = await tx.select().from(ledgerEntries).where(
      eq(ledgerEntries.workspaceId, wsId),
    );

    // Map DB rows (flat debitMinor/creditMinor columns) → domain
    // LedgerEntry (nested Money) so computeBalance can run on the
    // same shape it always has.
    const ledgerEntryRows: LedgerEntry[] = rows.map((r) => ({
      id: r.id,
      wsId: r.workspaceId,
      type: r.type,
      debit: r.debitMinor !== null
        ? { amountMinor: Number(r.debitMinor), currency: r.debitCurrency ?? currency }
        : null,
      credit: r.creditMinor !== null
        ? { amountMinor: Number(r.creditMinor), currency: r.creditCurrency ?? currency }
        : null,
      contraEntryId: r.contraEntryId,
      refType: r.refType as LedgerEntry["refType"],
      refId: r.refId,
      idempotencyKey: r.idempotencyKey,
      at: r.at.toISOString(),
      createdAt: r.createdAt.toISOString(),
    }));
    const balances = computeBalance(ledgerEntryRows, wsId);
    const availableBalance = Number(balances.get(currency) ?? 0n);

    // No race, no negative balance, ever.
    if (availableBalance < amountMinor) {
      throw new InsufficientFunds(wsId, currency, amountMinor, availableBalance);
    }

    // Debit the available account (payout_initiated). refType is
    // "contract" — the closest fit in [milestone|contract|case];
    // the real schema would add "payout" to the enum.
    await tx.insert(ledgerEntries).values({
      workspaceId: wsId,
      type: "payout_initiated",
      debitMinor: BigInt(amountMinor),
      debitCurrency: currency,
      creditMinor: null,
      creditCurrency: null,
      contraEntryId: null,
      refType: "contract",
      refId: payoutId,
      idempotencyKey: `${key}:init`,
      at: now,
    });

    // Insert the payout row — same idempotency key family as the
    // ledger entry. Unique constraint on idempotencyKey means a
    // duplicate request no-ops at the DB layer.
    const [payoutRow] = await tx.insert(payouts).values({
      id: payoutId,
      workspaceId: wsId,
      amountMinor: BigInt(amountMinor),
      currency,
      status: "in_transit",
      idempotencyKey: key,
      providerRef: null,
      createdAt: now,
      updatedAt: now,
    }).returning();
    if (!payoutRow) throw new Error("payout insert returned no rows");

    const payout: Payout = {
      id: payoutRow.id,
      wsId: payoutRow.workspaceId,
      amountMinor: Number(payoutRow.amountMinor),
      currency: payoutRow.currency,
      status: payoutRow.status,
      key: payoutRow.idempotencyKey,
      providerRef: payoutRow.providerRef,
      createdAt: payoutRow.createdAt.toISOString(),
      updatedAt: payoutRow.updatedAt.toISOString(),
    };

    // Provider call AFTER commit, outbox pattern: a queued job
    // sends it with the same key; provider's idempotency support
    // + our ledger key = at-most-once money movement.

    await recordActivity(tx, {
      wsId,
      kind: "supa.payout.requested",
      ref: { payoutId: payout.id, amount: amountMinor, currency },
    });

    return payout;
  });
}

// ───────────────────────────────────────────────
// confirmPayout — webhook: provider confirms money left
// ───────────────────────────────────────────────

// Webhook handling: provider confirmations are consumed as
// facts — "payout_confirmed" flips in_transit → external.
// A duplicate webhook hits the same idempotency key and no-ops.

export async function confirmPayout(
  wsId: string,
  payoutId: string,
  providerRef: string,
): Promise<Payout> {
  const now = new Date();

  return db.transaction(async (tx) => {
    // Lock + scope by wsId + id — tenancy in the WHERE.
    const [payoutRow] = await tx.select().from(payouts).where(
      and(eq(payouts.id, payoutId), eq(payouts.workspaceId, wsId)),
    );
    if (!payoutRow) {
      throw new Error(`payout ${payoutId} not found in workspace ${wsId}`);
    }

    const payout: Payout = {
      id: payoutRow.id,
      wsId: payoutRow.workspaceId,
      amountMinor: Number(payoutRow.amountMinor),
      currency: payoutRow.currency,
      status: payoutRow.status,
      key: payoutRow.idempotencyKey,
      providerRef: payoutRow.providerRef,
      createdAt: payoutRow.createdAt.toISOString(),
      updatedAt: payoutRow.updatedAt.toISOString(),
    };

    if (payout.status !== "in_transit") {
      // Duplicate webhook — idempotent no-op. The payout is already
      // confirmed or failed; a duplicate confirmation hits the same
      // idempotency key and no-ops.
      return payout;
    }

    // Credit the external account (payout_confirmed — money left the building).
    await tx.insert(ledgerEntries).values({
      workspaceId: wsId,
      type: "payout_confirmed",
      debitMinor: null,
      debitCurrency: null,
      creditMinor: payoutRow.amountMinor,
      creditCurrency: payoutRow.currency,
      contraEntryId: null,
      refType: "contract",
      refId: payoutId,
      idempotencyKey: `${payout.key}:confirm`,
      at: now,
    });

    // Flip the payout row → confirmed. Same tx as the ledger entry —
    // they commit together or not at all.
    const [updated] = await tx.update(payouts).set({
      status: "confirmed",
      providerRef,
      updatedAt: now,
    }).where(eq(payouts.id, payoutId)).returning();
    if (!updated) throw new Error(`payout ${payoutId} not found on update`);

    const confirmed: Payout = {
      ...payout,
      status: updated.status,
      providerRef: updated.providerRef,
      updatedAt: updated.updatedAt.toISOString(),
    };

    await recordActivity(tx, {
      wsId,
      kind: "supa.payout.confirmed",
      ref: { payoutId, providerRef },
    });

    return confirmed;
  });
}

// ───────────────────────────────────────────────
// failPayout — webhook: provider rejected, money back to available
// ───────────────────────────────────────────────

// A "payout_failed" writes the reversal entry (in_transit →
// available, auto) and notifies the freelancer — money never
// sits in limbo because a provider hiccoughed.

export async function failPayout(
  wsId: string,
  payoutId: string,
  reason: string,
): Promise<Payout> {
  const now = new Date();

  return db.transaction(async (tx) => {
    const [payoutRow] = await tx.select().from(payouts).where(
      and(eq(payouts.id, payoutId), eq(payouts.workspaceId, wsId)),
    );
    if (!payoutRow) {
      throw new Error(`payout ${payoutId} not found in workspace ${wsId}`);
    }

    const payout: Payout = {
      id: payoutRow.id,
      wsId: payoutRow.workspaceId,
      amountMinor: Number(payoutRow.amountMinor),
      currency: payoutRow.currency,
      status: payoutRow.status,
      key: payoutRow.idempotencyKey,
      providerRef: payoutRow.providerRef,
      createdAt: payoutRow.createdAt.toISOString(),
      updatedAt: payoutRow.updatedAt.toISOString(),
    };

    if (payout.status !== "in_transit") {
      // Duplicate webhook — idempotent no-op.
      return payout;
    }

    // Write the reversal entry: the original debit (payout_initiated)
    // is reversed by a credit (payout_failed). Money goes back to
    // available automatically — no manual intervention.
    await tx.insert(ledgerEntries).values({
      workspaceId: wsId,
      type: "payout_failed",
      debitMinor: null,
      debitCurrency: null,
      creditMinor: payoutRow.amountMinor,
      creditCurrency: payoutRow.currency,
      contraEntryId: null,
      refType: "contract",
      refId: payoutId,
      idempotencyKey: `${payout.key}:fail`,
      at: now,
    });

    // Flip the payout row → failed. Same tx as the reversal entry.
    const [updated] = await tx.update(payouts).set({
      status: "failed",
      updatedAt: now,
    }).where(eq(payouts.id, payoutId)).returning();
    if (!updated) throw new Error(`payout ${payoutId} not found on update`);

    const failed: Payout = {
      ...payout,
      status: updated.status,
      updatedAt: updated.updatedAt.toISOString(),
    };

    await recordActivity(tx, {
      wsId,
      kind: "supa.payout.failed",
      ref: { payoutId, reason },
    });

    return failed;
  });
}
