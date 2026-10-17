/**
 * CustomerRepository — the real DB implementation.
 *
 * Every function takes a WorkspaceScope (tenancy spine). The
 * repointReferences() function is called by the merge transaction
 * to repoint all referencing rows (invoices, activities, deals) to
 * the survivor customer.
 */

import { db } from "@supa/db";
import { customers, invoices, activityFacts, deals } from "@supa/db/schema";
import { eq, and, desc, ilike, inArray, ne } from "drizzle-orm";
import {
  createCustomer,
  updateContactInfo,
  transitionStatus,
  type Customer,
  type CreateCustomerInput,
  type CustomerRepository as ICustomerRepository,
} from "@supa/customers/customer";
import { asCurrency } from "@supa/money/money";
import type { WorkspaceScope } from "@supa/workspace-core/workspace";

function rowToCustomer(row: typeof customers.$inferSelect): Customer {
  return {
    id: row.id,
    wsId: row.workspaceId as any,
    name: row.name,
    businessName: row.businessName,
    emails: row.emails as any,
    phones: row.phones as any,
    addresses: row.addresses as any,
    currency: asCurrency(row.currency),
    taxId: row.taxId,
    tags: row.tags as string[],
    groups: row.groups as string[],
    notes: row.notes,
    status: row.status,
    createdBy: row.createdBy,
    archivedAt: row.archivedAt?.getTime() ?? null,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

export class CustomerRepositoryImpl implements ICustomerRepository {
  async create(scope: WorkspaceScope, input: CreateCustomerInput): Promise<Customer> {
    const c = createCustomer(input);
    const [row] = await db
      .insert(customers)
      .values({
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
      })
      .returning();
    if (!row) throw new Error("customer insert failed");
    return rowToCustomer(row);
  }

  async findById(scope: WorkspaceScope, id: string): Promise<Customer | null> {
    const [row] = await db
      .select()
      .from(customers)
      .where(and(eq(customers.id, id), eq(customers.workspaceId, scope.wsId as any)))
      .limit(1);
    return row ? rowToCustomer(row) : null;
  }

  async list(
    scope: WorkspaceScope,
    filter?: {
      status?: Customer["status"];
      tags?: readonly string[];
      groups?: readonly string[];
      search?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<readonly Customer[]> {
    const conditions = [eq(customers.workspaceId, scope.wsId as any)];
    if (filter?.status) {
      conditions.push(eq(customers.status, filter.status));
    } else {
      // Default: exclude archived.
      conditions.push(ne(customers.status, "archived"));
    }
    if (filter?.search) {
      conditions.push(ilike(customers.name, `%${filter.search}%`));
    }
    const rows = await db
      .select()
      .from(customers)
      .where(and(...conditions))
      .orderBy(desc(customers.updatedAt))
      .limit(filter?.limit ?? 50)
      .offset(filter?.offset ?? 0);
    return rows.map(rowToCustomer);
  }

  async updateContactInfo(
    scope: WorkspaceScope,
    id: string,
    changes: Partial<Pick<Customer, "name" | "businessName" | "emails" | "phones" | "addresses" | "taxId" | "tags" | "groups" | "notes" | "currency">>,
  ): Promise<Customer> {
    const [existing] = await db
      .select()
      .from(customers)
      .where(and(eq(customers.id, id), eq(customers.workspaceId, scope.wsId as any)))
      .limit(1);
    if (!existing) throw new Error(`customer ${id} not found`);
    const customer = rowToCustomer(existing);
    const updated = updateContactInfo(customer, changes);

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (changes.name !== undefined) updateData.name = updated.name;
    if (changes.businessName !== undefined) updateData.businessName = updated.businessName;
    if (changes.emails !== undefined) updateData.emails = updated.emails as any;
    if (changes.phones !== undefined) updateData.phones = updated.phones as any;
    if (changes.addresses !== undefined) updateData.addresses = updated.addresses as any;
    if (changes.taxId !== undefined) updateData.taxId = updated.taxId;
    if (changes.tags !== undefined) updateData.tags = updated.tags as any;
    if (changes.groups !== undefined) updateData.groups = updated.groups as any;
    if (changes.notes !== undefined) updateData.notes = updated.notes;
    if (changes.currency !== undefined) updateData.currency = updated.currency;

    await db
      .update(customers)
      .set(updateData)
      .where(and(eq(customers.id, id), eq(customers.workspaceId, scope.wsId as any)));

    return updated;
  }

  async transitionStatus(scope: WorkspaceScope, id: string, to: Customer["status"]): Promise<Customer> {
    const [existing] = await db
      .select()
      .from(customers)
      .where(and(eq(customers.id, id), eq(customers.workspaceId, scope.wsId as any)))
      .limit(1);
    if (!existing) throw new Error(`customer ${id} not found`);
    const customer = rowToCustomer(existing);
    const updated = transitionStatus(customer, to);

    await db
      .update(customers)
      .set({
        status: updated.status,
        archivedAt: updated.archivedAt ? new Date(updated.archivedAt) : null,
        updatedAt: new Date(),
      })
      .where(and(eq(customers.id, id), eq(customers.workspaceId, scope.wsId as any)));

    return updated;
  }

  async repointReferences(scope: WorkspaceScope, fromCustomerId: string, toCustomerId: string): Promise<void> {
    // Repoint invoices.
    await db
      .update(invoices)
      .set({ customerId: toCustomerId })
      .where(and(eq(invoices.customerId, fromCustomerId), eq(invoices.workspaceId, scope.wsId as any)));
    // Repoint activity facts.
    await db
      .update(activityFacts)
      .set({ customerId: toCustomerId })
      .where(and(eq(activityFacts.customerId, fromCustomerId), eq(activityFacts.workspaceId, scope.wsId as any)));
    // Repoint deals.
    await db
      .update(deals)
      .set({ customerId: toCustomerId })
      .where(and(eq(deals.customerId, fromCustomerId), eq(deals.workspaceId, scope.wsId as any)));
  }
}
