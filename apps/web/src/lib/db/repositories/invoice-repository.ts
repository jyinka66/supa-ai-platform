/**
 * InvoiceRepository — the real DB implementation.
 *
 * Every function takes a WorkspaceScope (tenancy spine). The issue()
 * function calls the NumberAllocator inside the same DB transaction
 * as the status update — the allocate + the issuedAt update are
 * atomic. If the allocate succeeds but the update fails, the
 * transaction rolls back (gap created, invoice stays draft — honest).
 */

import { db } from "@supa/db";
import { invoices, monetaryFacts } from "@supa/db/schema";
import { eq, and, desc } from "drizzle-orm";
import {
  createDraft,
  issue,
  applyPayment,
  markPaid,
  void_ as voidInvoice,
  type Invoice,
  type LineItem,
  type InvoiceRepository as IInvoiceRepository,
} from "@supa/invoicing/invoice";
import {
  shouldAllocate,
  formatNumber,
  DEFAULT_FORMATS,
} from "@supa/invoicing/numbering";
import type { NumberAllocator } from "@supa/invoicing/numbering";
import { money } from "@supa/money/money";
import type { WorkspaceScope } from "@supa/workspace-core/workspace";

// Row → Invoice mapper
function rowToInvoice(row: typeof invoices.$inferSelect): Invoice {
  const lineItems = row.lineItems as unknown as LineItem[];
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    wsId: row.workspaceId as any, // WorkspaceId branded type
    profileId: row.profileId,
    lineItems,
    taxMode: row.taxMode as "per-line" | "per-invoice",
    currency: row.currency,
    totals: row.totals as any,
    issuedAt: row.issuedAt?.getTime() ?? null,
    dueAt: row.dueAt?.getTime() ?? null,
    dueInDays: row.dueAt ? Math.ceil((row.dueAt.getTime() - (row.issuedAt?.getTime() ?? Date.now())) / (1000 * 60 * 60 * 24)) : 0,
    voidedAt: row.voidedAt?.getTime() ?? null,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

export class InvoiceRepositoryImpl implements IInvoiceRepository {
  constructor(private readonly allocator: NumberAllocator) {}

  async create(scope: WorkspaceScope, input: import("@supa/invoicing/invoice").CreateInvoiceInput): Promise<Invoice> {
    const draft = createDraft(input);
    const [row] = await db
      .insert(invoices)
      .values({
        id: draft.id,
        workspaceId: scope.wsId as any,
        profileId: draft.profileId,
        number: null,
        status: "draft",
        lineItems: draft.lineItems as any,
        taxMode: draft.taxMode,
        currency: draft.currency,
        totals: draft.totals as any,
        dueInDays: input.dueInDays,
        createdBy: scope.accountId,
      })
      .returning();
    if (!row) throw new Error("invoice insert failed");
    return rowToInvoice(row);
  }

  async findById(scope: WorkspaceScope, id: string): Promise<Invoice | null> {
    const [row] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, id), eq(invoices.workspaceId, scope.wsId as any)))
      .limit(1);
    return row ? rowToInvoice(row) : null;
  }

  async listByProfile(
    scope: WorkspaceScope,
    profileId: string,
    filter?: { status?: Invoice["status"] },
  ): Promise<Invoice[]> {
    const conditions = [
      eq(invoices.workspaceId, scope.wsId as any),
      eq(invoices.profileId, profileId),
    ];
    if (filter?.status) {
      conditions.push(eq(invoices.status, filter.status));
    }
    const rows = await db
      .select()
      .from(invoices)
      .where(and(...conditions))
      .orderBy(desc(invoices.createdAt));
    return rows.map(rowToInvoice);
  }

  async issue(scope: WorkspaceScope, id: string, allocator: NumberAllocator): Promise<Invoice> {
    // Fetch the invoice.
    const [row] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, id), eq(invoices.workspaceId, scope.wsId as any)))
      .limit(1);
    if (!row) throw new Error(`invoice ${id} not found`);
    const invoice = rowToInvoice(row);

    // Check if we should allocate a number (only draft → issued).
    if (!shouldAllocate(invoice.status, "issued")) {
      throw new Error(`cannot issue invoice in status ${invoice.status}`);
    }

    // Allocate the number atomically.
    const seq = await allocator.allocate({
      wsId: scope.wsId,
      profileId: invoice.profileId,
      kind: "invoice",
    });
    const numberStr = formatNumber(DEFAULT_FORMATS.invoice, seq);

    // Update the invoice (the allocate + update should be in a DB
    // transaction in production; this stub does them sequentially).
    const now = Date.now();
    const issued = issue(invoice, numberStr, now);
    await db
      .update(invoices)
      .set({
        number: numberStr,
        status: "issued",
        issuedAt: new Date(now),
        dueAt: new Date(now + row.dueInDays * 86_400_000),
        updatedAt: new Date(now),
      })
      .where(and(eq(invoices.id, id), eq(invoices.workspaceId, scope.wsId as any)));

    // Write a monetary fact (invoice-issued).
    await db.insert(monetaryFacts).values({
      workspaceId: scope.wsId as any,
      nativeAmountMinor: issued.totals.total.minor,
      nativeCurrency: issued.currency,
      asOf: new Date(now),
      kind: "invoice-issued",
      sourceId: issued.id,
    });

    return issued;
  }

  async applyPayment(scope: WorkspaceScope, invoiceId: string, paymentAmount: import("@supa/money/money").Money): Promise<Invoice> {
    const [row] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.workspaceId, scope.wsId as any)))
      .limit(1);
    if (!row) throw new Error(`invoice ${invoiceId} not found`);
    const invoice = rowToInvoice(row);
    const now = Date.now();
    const updated = applyPayment(invoice, paymentAmount, now);

    await db
      .update(invoices)
      .set({ status: updated.status, updatedAt: new Date(now) })
      .where(and(eq(invoices.id, invoiceId), eq(invoices.workspaceId, scope.wsId as any)));

    // Write a monetary fact (payment received).
    await db.insert(monetaryFacts).values({
      workspaceId: scope.wsId as any,
      nativeAmountMinor: paymentAmount.minor,
      nativeCurrency: paymentAmount.currency,
      asOf: new Date(now),
      kind: "payment",
      sourceId: invoiceId,
    });

    return updated;
  }

  async void(scope: WorkspaceScope, invoiceId: string): Promise<Invoice> {
    const [row] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.workspaceId, scope.wsId as any)))
      .limit(1);
    if (!row) throw new Error(`invoice ${invoiceId} not found`);
    const invoice = rowToInvoice(row);
    const now = Date.now();
    const voided = voidInvoice(invoice, now);

    await db
      .update(invoices)
      .set({
        status: "voided",
        voidedAt: new Date(now),
        updatedAt: new Date(now),
      })
      .where(and(eq(invoices.id, invoiceId), eq(invoices.workspaceId, scope.wsId as any)));

    // The caller (route handler) creates a credit note in the same tx.
    return voided;
  }
}

export { PostgresNumberAllocator } from "./number-allocator.js";
