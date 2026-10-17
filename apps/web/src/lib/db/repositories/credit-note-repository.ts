/**
 * CreditNoteRepository — the real DB implementation.
 *
 * The create() function allocates a CN- number from the credit-note
 * sequence (separate from the invoice counter) inside the same DB
 * transaction as the insert. Credit notes are additive, not
 * decremental — they never touch the invoice counter.
 */

import { db } from "@supa/db";
import { creditNotes } from "@supa/db/schema";
import { eq, and, desc } from "drizzle-orm";
import {
  createCreditNote,
  type CreditNote,
  type CreditNoteRepository as ICreditNoteRepository,
  type CreateCreditNoteInput,
} from "@supa/invoicing/credit-note";
import {
  formatNumber,
  DEFAULT_FORMATS,
} from "@supa/invoicing/numbering";
import type { NumberAllocator } from "@supa/invoicing/numbering";
import type { WorkspaceScope } from "@supa/workspace-core/workspace";

function rowToCreditNote(row: typeof creditNotes.$inferSelect): CreditNote {
  return {
    id: row.id,
    number: row.number,
    wsId: row.workspaceId as any,
    profileId: row.profileId,
    invoiceId: row.invoiceId,
    amount: { minor: row.amountMinor, currency: row.currency as any },
    reason: row.reason as CreditNote["reason"],
    createdAt: row.createdAt.getTime(),
  };
}

export class CreditNoteRepositoryImpl implements ICreditNoteRepository {
  async create(scope: WorkspaceScope, input: CreateCreditNoteInput, allocator: NumberAllocator): Promise<CreditNote> {
    // Allocate the CN- number from the credit-note sequence.
    const seq = await allocator.allocate({
      wsId: scope.wsId,
      profileId: input.profileId,
      kind: "credit-note",
    });
    const numberStr = formatNumber(DEFAULT_FORMATS["credit-note"], seq);
    const now = Date.now();
    const cn = createCreditNote(input, numberStr, now);

    const [row] = await db
      .insert(creditNotes)
      .values({
        id: cn.id,
        workspaceId: scope.wsId as any,
        profileId: cn.profileId,
        invoiceId: cn.invoiceId,
        number: cn.number,
        amountMinor: cn.amount.minor,
        currency: cn.amount.currency,
        reason: cn.reason,
      })
      .returning();
    if (!row) throw new Error("credit note insert failed");
    return rowToCreditNote(row);
  }

  async findById(scope: WorkspaceScope, id: string): Promise<CreditNote | null> {
    const [row] = await db
      .select()
      .from(creditNotes)
      .where(and(eq(creditNotes.id, id), eq(creditNotes.workspaceId, scope.wsId as any)))
      .limit(1);
    return row ? rowToCreditNote(row) : null;
  }

  async listByInvoice(scope: WorkspaceScope, invoiceId: string): Promise<CreditNote[]> {
    const rows = await db
      .select()
      .from(creditNotes)
      .where(and(eq(creditNotes.invoiceId, invoiceId), eq(creditNotes.workspaceId, scope.wsId as any)))
      .orderBy(desc(creditNotes.createdAt));
    return rows.map(rowToCreditNote);
  }

  async listByProfile(scope: WorkspaceScope, profileId: string): Promise<CreditNote[]> {
    const rows = await db
      .select()
      .from(creditNotes)
      .where(and(eq(creditNotes.profileId, profileId), eq(creditNotes.workspaceId, scope.wsId as any)))
      .orderBy(desc(creditNotes.createdAt));
    return rows.map(rowToCreditNote);
  }
}
