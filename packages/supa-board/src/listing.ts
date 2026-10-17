// A listing is the public face of a supa-source job. One job,
// one listing, draft → published → closed — and crucially,
// publish is a FACT, not a flag. The board renders from facts;
// an unlisted/closed job can never be re-published with edited
// history pretending it never existed (the invoice-void
// philosophy applied to public postings).

import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db } from "@supa/db";
import { listings, activityFacts } from "@supa/db/schema";
import { Money } from "@supa/freelance-core/job";

// FIX: import was "@supa/activities" — that module doesn't exist.
// Inlined the helper using the activityFacts table from @supa/db/schema,
// same pattern as freelance-core/src/store.ts.
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

export const ListingStatus = z.enum(["draft", "published", "closed"]);

export const Listing = z.object({
  id: z.string().uuid(),
  wsId: z.string().uuid(),
  jobId: z.string().uuid(),
  status: ListingStatus,
  publishedAt: z.string().datetime().nullable(),
  closedAt: z.string().datetime().nullable(),
  closesAt: z.string().datetime(),           // auto-close deadline — timezone-aware, per client tz
  budget: Money,
  budgetType: z.enum(["hourly", "fixed"]),
  aiSummary: z.string().max(2_000).nullable(), // AI-drafted, client-approved, never auto-published
});

export type ListingStatus = z.infer<typeof ListingStatus>;
export type Listing = z.infer<typeof Listing>;

// Map a Drizzle listings row to the domain Listing shape. The DB
// stores timestamps as Date and money as bigint; the wire/domain
// layer uses ISO strings + numbers (the money rule: JSON can't carry
// bigint, so the boundary is here, not in callers).
type ListingRow = typeof listings.$inferSelect;

function rowToListing(row: ListingRow): Listing {
  return {
    id: row.id,
    wsId: row.workspaceId,
    jobId: row.jobId,
    status: row.status,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    closesAt: row.closesAt.toISOString(),
    budget: {
      amountMinor: Number(row.budgetMinor),
      currency: row.budgetCurrency,
    },
    budgetType: row.budgetType as "hourly" | "fixed",
    aiSummary: row.aiSummary,
  } as Listing;
}

// ───────────────────────────────────────────────
// Status transitions — publish is a fact, not a flag
// ───────────────────────────────────────────────

const ALLOWED_TRANSITIONS: Record<ListingStatus, readonly ListingStatus[]> = {
  draft: ["published", "closed"],
  published: ["closed"],
  closed: [],
};

export function canTransition(from: ListingStatus, to: ListingStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

// ───────────────────────────────────────────────
// Publish — a FACT, not a flag
// ───────────────────────────────────────────────

export async function publishListing(
  wsId: string, listingId: string,
): Promise<Listing> {
  return db.transaction(async (tx) => {
    // Tenancy in the WHERE: a third wsId simply finds no row —
    // no explicit authz check needed, the scoped SELECT is the gate.
    const [l] = await tx.select().from(listings).where(
      and(eq(listings.id, listingId), eq(listings.workspaceId, wsId)),
    );
    if (!l) throw new Error(`listing ${listingId} not found in workspace ${wsId}`);

    if (l.status !== "draft") throw new Error(`cannot publish from ${l.status}`);

    // Draft-only rule: aiSummary cannot be written post-publish.
    // A summary that mutates after applicants saw it is a
    // trust leak — publish freezes it.
    const now = new Date();
    const [updated] = await tx.update(listings).set({
      status: "published",
      publishedAt: now,
      updatedAt: now,
    }).where(
      and(eq(listings.id, listingId), eq(listings.workspaceId, wsId)),
    ).returning();
    if (!updated) throw new Error(`listing ${listingId} not updated`);

    await recordActivity(tx, { wsId, kind: "supa.listing.published", ref: { listingId } });
    return rowToListing(updated);
  });
}

// ───────────────────────────────────────────────
// Close — manual or auto
// ───────────────────────────────────────────────

export async function closeListing(
  wsId: string, listingId: string,
): Promise<Listing> {
  return db.transaction(async (tx) => {
    const [l] = await tx.select().from(listings).where(
      and(eq(listings.id, listingId), eq(listings.workspaceId, wsId)),
    );
    if (!l) throw new Error(`listing ${listingId} not found in workspace ${wsId}`);

    if (!canTransition(l.status, "closed")) {
      throw new Error(`cannot close from ${l.status}`);
    }

    const now = new Date();
    const [updated] = await tx.update(listings).set({
      status: "closed",
      closedAt: now,
      updatedAt: now,
    }).where(
      and(eq(listings.id, listingId), eq(listings.workspaceId, wsId)),
    ).returning();
    if (!updated) throw new Error(`listing ${listingId} not updated`);

    await recordActivity(tx, { wsId, kind: "supa.listing.closed", ref: { listingId } });
    return rowToListing(updated);
  });
}

// Auto-close: a scheduled fact, not a cron mutation. The
// scheduler asserts "this listing is past closesAt and still
// published" as a fact; the transition does the closing. Same
// pattern as CRM follow-up reminders — the clock is data.
export function shouldAutoClose(listing: Listing, now: string = new Date().toISOString()): boolean {
  return listing.status === "published" && now >= listing.closesAt;
}
