/**
 * ConvertRepository — the real DB implementation.
 *
 * The anchor thesis made concrete: the CRM feeds the invoice, the
 * money facts flow back to the CRM, and the owner's mental model —
 * "customer → deal → invoice → paid" — is literally the data flow.
 *
 * convert(): create invoice draft + dealInvoiceLink + activity fact
 *   in one DB transaction. The invoice's future payment facts write
 *   back to the deal via receivePaymentFeedback.
 *
 * receivePaymentFeedback(): the loop that closes — the invoicing
 *   pass's payment fact fans out an activity fact on the deal. If
 *   the deal's linked invoice is fully paid + the deal is not in a
 *   terminal stage, prompt (not force) Won.
 *
 * acceptWonPrompt() / dismissWonPrompt(): the owner decides. Won is
 *   a deliberate, audited action; a dismissed prompt is recorded
 *   for analytics ("how often do owners accept vs dismiss?").
 */

import { db } from "@supa/db";
import { invoices, dealInvoiceLinks, activityFacts, deals } from "@supa/db/schema";
import { eq, and } from "drizzle-orm";
import {
  convertDealToInvoice,
  shouldPromptWon,
  type ConvertDealInput,
  type ConvertResult,
  type PaymentFeedback,
  type WonPrompt,
  type ConvertRepository as IConvertRepository,
} from "@supa/deals/convert";
import { createDraft } from "@supa/invoicing/invoice";
import { fromMinor, asCurrency } from "@supa/money/money";
import type { Deal } from "@supa/deals/pipeline";
import type { WorkspaceScope } from "@supa/workspace-core/workspace";

function rowToDeal(row: typeof deals.$inferSelect): Deal {
  return {
    id: row.id,
    wsId: row.workspaceId as any,
    customerId: row.customerId,
    title: row.title,
    value: fromMinor(row.valueMinor, asCurrency(row.currency)),
    expectedClose: row.expectedClose.getTime(),
    stageId: row.stageId,
    probability: row.probability ? parseFloat(row.probability) : null,
    source: row.source as Deal["source"],
    owner: row.owner,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

export class ConvertRepositoryImpl implements IConvertRepository {
  async convert(
    scope: WorkspaceScope,
    input: ConvertDealInput,
    invoiceId: string,
    actor: string,
  ): Promise<ConvertResult> {
    const now = Date.now();

    // Pure function — copies deal line items (or single value) into an
    // invoice draft + builds the dealInvoiceLink record.
    const result = convertDealToInvoice(input, invoiceId, actor, now);

    // Create the invoice draft via invoicing's createDraft (computes
    // totals immediately — the user can preview before sending).
    const draft = createDraft(result.invoiceInput, now);

    // Insert the invoice row. Status=draft, number=null (numbers
    // allocate at first send — abandoned drafts cost nothing).
    await db.insert(invoices).values({
      id: draft.id,
      workspaceId: scope.wsId as any,
      profileId: draft.profileId,
      customerId: input.customerId,
      number: null,
      status: "draft",
      lineItems: draft.lineItems as any,
      taxMode: draft.taxMode,
      currency: draft.currency,
      totals: draft.totals as any,
      dueInDays: input.dueInDays,
      createdBy: actor,
    });

    // Insert the dealInvoiceLink (the audit trail: deal → invoice).
    await db.insert(dealInvoiceLinks).values({
      dealId: input.dealId,
      invoiceId,
      workspaceId: scope.wsId as any,
      convertedAt: new Date(now),
      convertedBy: actor,
    });

    // Write a deal_converted activity fact on the deal. The DB column
    // is text (no enum constraint), so the convert-specific kind is
    // honest in the timeline.
    await db.insert(activityFacts).values({
      workspaceId: scope.wsId as any,
      dealId: input.dealId,
      kind: "deal_stage",
      content: `Deal converted to invoice ${invoiceId}`,
      occurredAt: new Date(now),
      actor,
      source: "system",
    });

    return result;
  }

  async receivePaymentFeedback(
    scope: WorkspaceScope,
    feedback: PaymentFeedback,
  ): Promise<{ wonPrompt: WonPrompt | null }> {
    // Write the invoice_paid activity fact on the deal — the loop
    // that closes (CRM feeds invoice, money facts flow back to CRM).
    await db.insert(activityFacts).values({
      workspaceId: scope.wsId as any,
      dealId: feedback.dealId,
      kind: "invoice_paid",
      refId: feedback.invoiceId,
      content: `Invoice ${feedback.invoiceNumber} paid (${feedback.amountDisplay})`,
      occurredAt: new Date(feedback.paidAt),
      actor: "system",
      source: "system",
    });

    // Fetch the deal.
    const [dealRow] = await db
      .select()
      .from(deals)
      .where(and(eq(deals.id, feedback.dealId), eq(deals.workspaceId, scope.wsId as any)))
      .limit(1);
    if (!dealRow) {
      return { wonPrompt: null };
    }

    // Fetch linked invoices (for the shouldPromptWon check).
    const linkedInvoiceRows = await db
      .select({
        id: invoices.id,
        number: invoices.number,
        status: invoices.status,
      })
      .from(invoices)
      .innerJoin(dealInvoiceLinks, eq(dealInvoiceLinks.invoiceId, invoices.id))
      .where(
        and(
          eq(dealInvoiceLinks.dealId, feedback.dealId),
          eq(dealInvoiceLinks.workspaceId, scope.wsId as any),
        ),
      );

    const deal = rowToDeal(dealRow);
    const wonPrompt = shouldPromptWon(
      deal,
      linkedInvoiceRows.map((r) => ({
        id: r.id,
        number: r.number ?? "",
        status: r.status,
      })),
    );
    return { wonPrompt };
  }

  async acceptWonPrompt(scope: WorkspaceScope, dealId: string): Promise<Deal> {
    const [row] = await db
      .select()
      .from(deals)
      .where(and(eq(deals.id, dealId), eq(deals.workspaceId, scope.wsId as any)))
      .limit(1);
    if (!row) throw new Error(`deal ${dealId} not found`);
    const deal = rowToDeal(row);
    const now = Date.now();

    // Move the deal to the "won" stage.
    await db
      .update(deals)
      .set({ stageId: "won", updatedAt: new Date(now) })
      .where(and(eq(deals.id, dealId), eq(deals.workspaceId, scope.wsId as any)));

    // Write a deal_stage activity fact recording the acceptance.
    await db.insert(activityFacts).values({
      workspaceId: scope.wsId as any,
      dealId,
      kind: "deal_stage",
      content: `Deal moved from ${deal.stageId} to won (accepted Won prompt)`,
      occurredAt: new Date(now),
      actor: scope.accountId,
      source: "system",
    });

    return { ...deal, stageId: "won", updatedAt: now };
  }

  async dismissWonPrompt(
    scope: WorkspaceScope,
    dealId: string,
    invoiceId: string,
  ): Promise<void> {
    const now = Date.now();

    // Write a deal_stage activity fact recording the dismissal —
    // analytics: "how often do owners accept vs dismiss the Won prompt?"
    await db.insert(activityFacts).values({
      workspaceId: scope.wsId as any,
      dealId,
      kind: "deal_stage",
      refId: invoiceId,
      content: `Won prompt dismissed for invoice ${invoiceId}`,
      occurredAt: new Date(now),
      actor: scope.accountId,
      source: "system",
    });
  }
}
