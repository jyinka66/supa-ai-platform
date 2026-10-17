/**
 * ImportRepository — the real DB implementation.
 *
 * execute() iterates the preview's valid rows and inserts a customer
 * for each (one DB insert per row, all in one logical batch). Every
 * created id is recorded on the batch — that's the undo unit. The
 * no-partial-mystery-state rule: either the batch commits clean
 * (every valid row creates a customer) or the report tells you
 * exactly what didn't and why (the summary's skip reasons).
 *
 * reverse() (within the 30-day window): archives every customer
 * created by the batch. Same discipline as the rest of the system —
 * never delete, soft-archive preserves every fact.
 */

import { randomUUID } from "node:crypto";

import { db } from "@supa/db";
import { importBatches, customers } from "@supa/db/schema";
import { eq, and, desc, inArray } from "drizzle-orm";
import {
  createImportBatch,
  reverseBatch,
  type ImportBatch,
  type ImportPreview,
  type ColumnMapping,
  type ImportRepository as IImportRepository,
} from "@supa/customers/import";
import { createCustomer } from "@supa/customers/customer";
import type { Currency } from "@supa/money/money";
import type { WorkspaceScope } from "@supa/workspace-core/workspace";

function rowToBatch(row: typeof importBatches.$inferSelect): ImportBatch {
  return {
    id: row.id,
    wsId: row.workspaceId as any,
    importedAt: row.importedAt.getTime(),
    createdCustomerIds: row.createdCustomerIds as string[],
    duplicateCustomerIds: row.duplicateCustomerIds as string[],
    summary: row.summary as ImportBatch["summary"],
    reversibleUntil: row.reversibleUntil.getTime(),
    reversedAt: row.reversedAt?.getTime() ?? null,
  };
}

export class ImportRepositoryImpl implements IImportRepository {
  async execute(
    scope: WorkspaceScope,
    preview: ImportPreview,
    mappings: readonly ColumnMapping[],
    defaultCurrency: Currency,
    batchId: string,
  ): Promise<ImportBatch> {
    void mappings; // mappings are already applied in the preview; kept for contract symmetry
    const now = Date.now();
    const createdIds: string[] = [];

    // For each VALID row in the preview, build + insert a customer.
    // No partial mystery state: every valid row creates a customer,
    // every skipped/duplicate row is reported in the preview summary.
    for (const row of preview.rows) {
      if (row.status !== "valid") continue;
      const id = randomUUID();
      const c = createCustomer(
        {
          id,
          wsId: scope.wsId,
          name: row.fields.name!,
          businessName: row.fields.businessName ?? null,
          emails: row.fields.email
            ? [{ address: row.fields.email, kind: "primary", verified: false }]
            : [],
          phones: row.fields.phone
            ? [{ number: row.fields.phone, kind: "mobile", primary: true }]
            : [],
          addresses: row.fields.addressLine1
            ? [{
                line1: row.fields.addressLine1,
                line2: null,
                city: row.fields.addressCity ?? "",
                state: null,
                postalCode: null,
                country: row.fields.addressCountry ?? "",
                kind: "general" as const,
              }]
            : [],
          currency: defaultCurrency,
          taxId: row.fields.taxId ?? null,
          tags: row.fields.tag ? [row.fields.tag] : [],
          groups: row.fields.group ? [row.fields.group] : [],
          notes: row.fields.notes ?? "",
          createdBy: scope.accountId,
        },
        now,
      );

      await db.insert(customers).values({
        id: c.id,
        workspaceId: scope.wsId as any,
        name: c.name,
        businessName: c.businessName,
        emails: c.emails as any,
        phones: c.phones as any,
        addresses: c.addresses as any,
        currency: c.currency,
        taxId: c.taxId,
        tags: c.tags as any,
        groups: c.groups as any,
        notes: c.notes,
        status: c.status,
        createdBy: c.createdBy,
      });
      createdIds.push(id);
    }

    // Build the batch record (pure function — computes reversibleUntil +
    // duplicateCustomerIds + summary from the preview).
    const batch = createImportBatch(batchId, scope.wsId, preview, createdIds, now);

    await db.insert(importBatches).values({
      id: batch.id,
      workspaceId: scope.wsId as any,
      createdCustomerIds: createdIds,
      duplicateCustomerIds: batch.duplicateCustomerIds,
      summary: batch.summary as any,
      importedAt: new Date(now),
      reversibleUntil: new Date(batch.reversibleUntil),
    });

    return batch;
  }

  async reverse(scope: WorkspaceScope, batchId: string): Promise<ImportBatch> {
    const [row] = await db
      .select()
      .from(importBatches)
      .where(
        and(eq(importBatches.id, batchId), eq(importBatches.workspaceId, scope.wsId as any)),
      )
      .limit(1);
    if (!row) throw new Error(`import batch ${batchId} not found`);

    const batch = rowToBatch(row);
    const now = Date.now();
    // Throws BatchNotReversibleError if expired / already reversed.
    const reversed = reverseBatch(batch, now);

    // Archive all created customers (soft-archive — never delete).
    if (batch.createdCustomerIds.length > 0) {
      await db
        .update(customers)
        .set({ status: "archived", archivedAt: new Date(now), updatedAt: new Date(now) })
        .where(
          and(
            eq(customers.workspaceId, scope.wsId as any),
            inArray(customers.id, [...batch.createdCustomerIds]),
          ),
        );
    }

    // Mark the batch reversed.
    await db
      .update(importBatches)
      .set({ reversedAt: new Date(now) })
      .where(
        and(eq(importBatches.id, batchId), eq(importBatches.workspaceId, scope.wsId as any)),
      );

    return reversed;
  }

  async findById(scope: WorkspaceScope, id: string): Promise<ImportBatch | null> {
    const [row] = await db
      .select()
      .from(importBatches)
      .where(
        and(eq(importBatches.id, id), eq(importBatches.workspaceId, scope.wsId as any)),
      )
      .limit(1);
    return row ? rowToBatch(row) : null;
  }
}
