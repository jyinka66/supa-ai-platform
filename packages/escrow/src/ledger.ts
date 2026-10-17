// Append-only double-entry ledger. No UPDATE, no DELETE —
// corrections are reversing entries (the invoice-void rule at
// the money layer, where it matters most).

import { z } from "zod";
import { Money } from "@supa/freelance-core/job";

// FIX: missing imports — added z + Money.

export const LedgerEntryType = z.enum([
  "escrow_funded",        // client card → ledger, held
  "escrow_released",      // held → freelancer available, minus fee
  "fee_collected",        // held → platform revenue
  "payout_initiated",     // available → in_transit (provider pending)
  "payout_confirmed",     // in_transit → external (provider ack)
  "payout_failed",        // in_transit → available (reversal, auto)
  "refund_issued",        // held → external (client refund on cancel)
  "adjustment",           // admin mediation outcome, requires case ref
]);

export const LedgerEntry = z.object({
  id: z.string().uuid(),
  wsId: z.string().uuid(),
  type: LedgerEntryType,
  debit: Money.nullable(),    // exactly one of debit/credit per leg
  credit: Money.nullable(),
  contraEntryId: z.string().uuid().nullable(),  // pairs legs into transactions
  refType: z.enum(["milestone", "contract", "case"]),
  refId: z.string().uuid(),
  idempotencyKey: z.string(),  // the invariant key — see below
  at: z.string().datetime(),
  // FIX: added createdAt for audit trail (when the row was inserted,
  // distinct from `at` which is the effective datetime of the entry).
  createdAt: z.string().datetime(),
}).refine(
  // FIX: "exactly one of debit/credit per leg" was a comment but not
  // enforced. Both null = no money moved = meaningless entry.
  // Both non-null = ambiguous (which leg?). Enforce exactly one.
  (entry) => (entry.debit !== null) !== (entry.credit !== null),
  {
    message: "exactly one of debit/credit must be non-null per ledger entry",
  },
);

export type LedgerEntryType = z.infer<typeof LedgerEntryType>;
export type LedgerEntry = z.infer<typeof LedgerEntry>;

// ───────────────────────────────────────────────
// Idempotency — the invariant key
// ───────────────────────────────────────────────

/**
 * Build the idempotency key for a ledger entry. The key ensures
 * that re-running the same operation (e.g. a milestone release
 * that fires twice due to a retry) produces the SAME key — and
 * the DB's unique constraint on idempotencyKey prevents the
 * duplicate insert.
 *
 * Format: `${type}|${refType}|${refId}|${leg}`
 *
 * Example: "escrow_released|milestone|<milestone-id>|debit"
 *          "escrow_released|milestone|<milestone-id>|credit"
 *
 * The leg suffix (debit/credit) distinguishes the two legs of
 * a double-entry transaction — both legs share the same ref,
 * but each has its own idempotency key.
 */
export function buildIdempotencyKey(
  type: LedgerEntryType,
  refType: LedgerEntry["refType"],
  refId: string,
  leg: "debit" | "credit",
): string {
  return `${type}|${refType}|${refId}|${leg}`;
}

// ───────────────────────────────────────────────
// Double-entry pair — debit + credit legs
// ───────────────────────────────────────────────

/**
 * A double-entry transaction: two legs (debit + credit) paired
 * via contraEntryId. The debit leg removes money from one account;
 * the credit leg adds it to another. Both legs must have the
 * same amount + currency.
 *
 * Append-only: corrections are reversing entries (a new pair with
 * the legs flipped), never an UPDATE or DELETE. Same rule as invoice
 * voids + customer merges — money documents never vanish.
 */
export interface DoubleEntry {
  readonly debitLeg: LedgerEntry;
  readonly creditLeg: LedgerEntry;
}

/**
 * Build a double-entry pair. Both legs share the same ref + amount.
 * The debit leg's contraEntryId = credit leg's id, and vice versa.
 * Each leg has its own idempotency key (distinguished by leg suffix).
 */
export function buildDoubleEntry(
  type: LedgerEntryType,
  refType: LedgerEntry["refType"],
  refId: string,
  wsId: string,
  amount: Money,
  at: string = new Date().toISOString(),
): DoubleEntry {
  const debitId = crypto.randomUUID();
  const creditId = crypto.randomUUID();
  const now = new Date().toISOString();

  const debitLeg: LedgerEntry = {
    id: debitId,
    wsId,
    type,
    debit: amount,
    credit: null,
    contraEntryId: creditId,
    refType,
    refId,
    idempotencyKey: buildIdempotencyKey(type, refType, refId, "debit"),
    at,
    createdAt: now,
  };

  const creditLeg: LedgerEntry = {
    id: creditId,
    wsId,
    type,
    debit: null,
    credit: amount,
    contraEntryId: debitId,
    refType,
    refId,
    idempotencyKey: buildIdempotencyKey(type, refType, refId, "credit"),
    at,
    createdAt: now,
  };

  return { debitLeg, creditLeg };
}

// ───────────────────────────────────────────────
// Balance query — derived from entries (never stored)
// ───────────────────────────────────────────────

import { fromMinor, asCurrency, type Money as DomainMoney } from "@supa/money/money";

/**
 * Compute the balance for a workspace from ledger entries.
 * Balance = sum(credits) − sum(debits), in minor units.
 *
 * Derived, never stored — a stored balance is a cached lie that
 * drifts (the no-drift rule, same as customer LTV and contract
 * progress). The query recomputes from the append-only fact table
 * every time.
 *
 * Currency handling: if entries span multiple currencies, the
 * balance is computed per-currency and returned as a map. The
 * caller converts to base currency at report time (as-of rates,
 * the reports engine's FX honesty rule).
 */
export function computeBalance(
  entries: readonly LedgerEntry[],
  wsId: string,
): Map<string, bigint> {
  const balances = new Map<string, bigint>();
  for (const entry of entries) {
    if (entry.wsId !== wsId) continue;
    const currency = (entry.debit ?? entry.credit)!.currency;
    const current = balances.get(currency) ?? 0n;
    if (entry.credit) {
      balances.set(currency, current + BigInt(entry.credit.amountMinor));
    } else if (entry.debit) {
      balances.set(currency, current - BigInt(entry.debit.amountMinor));
    }
  }
  return balances;
}

// ───────────────────────────────────────────────
// Reversal — corrections are new entries, never mutations
// ───────────────────────────────────────────────

/**
 * Build a reversal entry for a given original entry. The reversal
 * flips the debit/credit legs — if the original debited, the reversal
 * credits (and vice versa). Same ref + same type (with "adjustment"
 * if it's a mediation outcome).
 *
 * This is the invoice-void rule at the money layer: corrections are
 * reversing entries, never UPDATEs or DELETEs. The original entry
 * stays in the ledger; the reversal cancels it out.
 */
export function buildReversal(
  original: LedgerEntry,
  reason: string,
  at: string = new Date().toISOString(),
): LedgerEntry {
  return {
    id: crypto.randomUUID(),
    wsId: original.wsId,
    type: "adjustment",
    // Flip legs: original debit → reversal credit, original credit → reversal debit.
    debit: original.credit,   // if original credited X, reversal debits X
    credit: original.debit,   // if original debited X, reversal credits X
    contraEntryId: original.id,  // links back to the original
    refType: original.refType,
    refId: original.refId,
    idempotencyKey: `reversal|${original.id}`,
    at,
    createdAt: new Date().toISOString(),
  };
}
