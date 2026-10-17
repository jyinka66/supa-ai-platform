// POST /api/supa-os/ledger/post
//
// Posts a double-entry transaction to the immutable ledger. The request
// provides the entries (debits + credits); the API returns the new ledger
// state + the transaction id + the posted entries with their hashes.
//
// Body:
//   ledger: ImmutableLedger (current state — null on first call, the
//           client should pass {} to start a fresh ledger)
//   entries: Array<{ accountCode, entryType: "debit"|"credit", amount, description }>
//   currency: "USD" | "EUR" | "NGN" | ...
//   sourceType: "loan" | "transfer" | "payment" | ...
//   sourceId: string
//
// Auth: admin (senior — financial actions require senior role).

import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody } from "@/lib/api/route-helpers";
import { postDoubleEntryTransaction, type ImmutableLedger } from "@/lib/supa-os/fintech-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EntrySchema = z.object({
  accountCode: z.string().min(1).max(50),
  entryType: z.enum(["debit", "credit"]),
  amount: z.number().positive().max(1_000_000_000),
  description: z.string().min(1).max(500),
});

const BodySchema = z.object({
  ledger: z.object({}).passthrough().default({}), // ImmutableLedger; accept any shape
  entries: z.array(EntrySchema).min(2, "Double-entry requires at least 2 entries"),
  currency: z.string().min(3).max(3),
  sourceType: z.string().min(1).max(50),
  sourceId: z.string().min(1).max(100),
});

export const POST = adminOnly("senior", async (req, ctx) => {
  const body = await parseJsonBody(req, BodySchema);

  // Validate double-entry balance: debits must equal credits.
  const debitTotal = body.entries.filter((e) => e.entryType === "debit").reduce((s, e) => s + e.amount, 0);
  const creditTotal = body.entries.filter((e) => e.entryType === "credit").reduce((s, e) => s + e.amount, 0);
  if (Math.abs(debitTotal - creditTotal) > 0.001) {
    return okResponse({
      ok: false,
      error: "DOUBLE_ENTRY_IMBALANCE",
      debitTotal,
      creditTotal,
    }, 400);
  }

  const result = postDoubleEntryTransaction({
    ledger: body.ledger as unknown as ImmutableLedger,
    entries: body.entries,
    currency: body.currency,
    sourceType: body.sourceType,
    sourceId: body.sourceId,
  });

  return okResponse({
    transactionId: result.transactionId,
    entries: result.entries,
    ledger: result.ledger,
    postedBy: ctx.admin!.adminId,
    postedAt: new Date().toISOString(),
  });
});
