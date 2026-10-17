// Self-governing marketplace — automated publish, reputation, takedowns.
//
// The spec: "The marketplace is self-governing. Publishing is automated where
// safe, escalated where risky. Reputation drives trust. Ratings drive discovery.
// Revenue share drives participation. Takedowns are algorithmic first, human second."
//
// This module provides:
//   - publishItem — submit for publishing (auto-approve or escalate per policy).
//   - rateItem — user ratings (drives discovery).
//   - installItem — track installs.
//   - takeDownItem — algorithmic or manual takedown.
//   - evaluatePublishPolicy — the policy engine check (auto vs manual).

import { db } from "@supa/db";
import { marketplaceItems, developerOrgs } from "@supa/db/schema";
import { eq, and, sql, desc } from "drizzle-orm";
import { evaluatePolicy } from "./policy-engine";
import { adminAudit } from "@/lib/admin/audit";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type MarketplaceKind = "template" | "agent" | "connector" | "vertical" | "tool";
export type MarketplaceStatus = "draft" | "pending_review" | "published" | "suspended" | "taken_down";
export type ReviewType = "automated" | "manual" | "escalated";

export interface MarketplaceItem {
  id: string;
  kind: MarketplaceKind;
  slug: string;
  title: string;
  description: string;
  authorOrgId: string | null;
  authorName: string;
  version: string;
  status: MarketplaceStatus;
  reviewType: ReviewType;
  ratingAvg: number;
  ratingCount: number;
  installCount: number;
  revenueSharePct: number;
  manifest: Record<string, unknown>;
  tags: string[];
  publishedAt: Date | null;
  createdAt: Date;
}

export class MarketplaceError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "MarketplaceError";
  }
}

// ───────────────────────────────────────────────
// publishItem — submit for publishing.
//
// The self-governing flow:
//   1. Evaluate the publish policy (auto-approve vs escalate).
//   2. If auto-approve: status → published, review_type = 'automated'.
//   3. If escalate: status → pending_review, review_type = 'manual'.
//   4. The review queue is monitored by admins.
// ───────────────────────────────────────────────

export interface PublishItemInput {
  kind: MarketplaceKind;
  slug: string;
  title: string;
  description: string;
  authorOrgId?: string;
  authorName: string;
  manifest: Record<string, unknown>;
  tags?: string[];
  version?: string;
}

export async function publishItem(input: PublishItemInput): Promise<MarketplaceItem> {
  // Check if already exists.
  const existing = await db
    .select({ id: marketplaceItems.id })
    .from(marketplaceItems)
    .where(eq(marketplaceItems.slug, input.slug))
    .limit(1);

  if (existing.length > 0) {
    throw new MarketplaceError("slug_already_exists", 409);
  }

  // Fetch the author org (for reputation + verified check).
  let orgVerified = false;
  let orgReputation = 50;
  if (input.authorOrgId) {
    const org = await db
      .select({ verified: developerOrgs.verified, reputation: developerOrgs.reputationScore })
      .from(developerOrgs)
      .where(eq(developerOrgs.id, input.authorOrgId as any))
      .limit(1);
    if (org[0]) {
      orgVerified = org[0].verified;
      orgReputation = Number(org[0].reputation);
    }
  }

  // Evaluate the publish policy.
  const decision = evaluatePolicy("marketplace.publish", {
    author_verified: orgVerified,
    author_reputation: orgReputation,
    kind: input.kind,
  });

  const autoApprove = decision?.action?.auto_approve === true;
  const escalate = decision?.action?.escalate === true;

  const status: MarketplaceStatus = autoApprove ? "published" : "pending_review";
  const reviewType: ReviewType = autoApprove ? "automated" : escalate ? "escalated" : "manual";

  const rows = await db
    .insert(marketplaceItems)
    .values({
      kind: input.kind,
      slug: input.slug,
      title: input.title,
      description: input.description,
      ...(input.authorOrgId ? { authorOrgId: input.authorOrgId as any } : {}),
      authorName: input.authorName,
      version: input.version ?? "1.0.0",
      status,
      reviewType,
      reviewResult: {
        auto_approve: autoApprove,
        policy: decision?.policyKey,
        author_verified: orgVerified,
        author_reputation: orgReputation,
      },
      manifest: input.manifest,
      tags: input.tags ?? [],
      ...(autoApprove ? { publishedAt: new Date() } : {}),
    })
    .returning({ id: marketplaceItems.id });

  const row = rows[0];
  if (!row) throw new MarketplaceError("item_insert_failed", 500);

  await auditMarketplace("marketplace.item.published", row.id as string, {
    slug: input.slug,
    kind: input.kind,
    autoApproved: autoApprove,
    reviewType,
  });

  return (await getItem(input.slug))!;
}

// ───────────────────────────────────────────────
// approveItem — manual review approval.
// ───────────────────────────────────────────────

export async function approveItem(itemId: string, reviewerId: string): Promise<MarketplaceItem> {
  const result = await db
    .update(marketplaceItems)
    .set({ status: "published", publishedAt: new Date(), reviewType: "manual", updatedAt: new Date() })
    .where(and(eq(marketplaceItems.id, itemId as any), eq(marketplaceItems.status, "pending_review")))
    .returning({ id: marketplaceItems.id });

  if (result.length === 0) throw new MarketplaceError("item_not_found_or_not_pending", 404);

  await auditMarketplace("marketplace.item.approved", itemId, { reviewerId });
  return (await getItemById(itemId))!;
}

// ───────────────────────────────────────────────
// takeDownItem — algorithmic or manual takedown.
// ───────────────────────────────────────────────

export async function takeDownItem(
  itemId: string,
  reason: string,
  by: string, // 'algorithm' or 'human:<admin_id>'
): Promise<void> {
  const result = await db
    .update(marketplaceItems)
    .set({ status: "taken_down", takedownReason: reason, takedownAt: new Date(), takedownBy: by, updatedAt: new Date() })
    .where(and(eq(marketplaceItems.id, itemId as any), sql`${marketplaceItems.status} != 'taken_down'`))
    .returning({ id: marketplaceItems.id });

  if (result.length === 0) throw new MarketplaceError("item_not_found_or_already_taken_down", 404);

  await auditMarketplace("marketplace.item.taken_down", itemId, { reason, by });
}

// ───────────────────────────────────────────────
// algorithmicTakedowns — the cron checks ratings + malware.
// ───────────────────────────────────────────────

export async function runAlgorithmicTakedowns(): Promise<{ suspended: number; takenDown: number }> {
  // Low rating takedown: rating < 2.0 and > 50 ratings.
  const lowRated = await db
    .update(marketplaceItems)
    .set({ status: "suspended", takedownReason: "low_rating", takedownAt: new Date(), takedownBy: "algorithm", updatedAt: new Date() })
    .where(
      and(
        eq(marketplaceItems.status, "published"),
        sql`${marketplaceItems.ratingAvg} < 2.0`,
        sql`${marketplaceItems.ratingCount} >= 50`,
      ),
    )
    .returning({ id: marketplaceItems.id });

  // Malware takedown: items flagged as malware (would be set by the scan cron).
  const malware = await db
    .update(marketplaceItems)
    .set({ status: "taken_down", takedownReason: "malware", takedownAt: new Date(), takedownBy: "algorithm", updatedAt: new Date() })
    .where(
      and(
        eq(marketplaceItems.status, "published"),
        sql`${marketplaceItems.takedownReason} = 'malware_detected'`,
      ),
    )
    .returning({ id: marketplaceItems.id });

  return { suspended: lowRated.length, takenDown: malware.length };
}

// ───────────────────────────────────────────────
// rateItem — user ratings (drives discovery).
// ───────────────────────────────────────────────

export async function rateItem(itemId: string, rating: number): Promise<void> {
  if (rating < 1 || rating > 5) throw new MarketplaceError("invalid_rating", 400);

  // Incremental update of the average.
  await db.execute(sql`
    update marketplace_items
       set rating_avg = (rating_avg * rating_count + ${rating}) / (rating_count + 1),
           rating_count = rating_count + 1,
           updated_at = now()
     where id = ${itemId}::uuid
  `);
}

// ───────────────────────────────────────────────
// installItem — track installs.
// ───────────────────────────────────────────────

export async function installItem(itemId: string): Promise<void> {
  await db.execute(sql`
    update marketplace_items set install_count = install_count + 1, updated_at = now()
    where id = ${itemId}::uuid
  `);
}

// ───────────────────────────────────────────────
// Query helpers.
// ───────────────────────────────────────────────

export async function getItem(slug: string): Promise<MarketplaceItem | null> {
  const rows = await db
    .select()
    .from(marketplaceItems)
    .where(eq(marketplaceItems.slug, slug))
    .limit(1);
  return mapRow(rows[0]);
}

export async function getItemById(id: string): Promise<MarketplaceItem | null> {
  const rows = await db
    .select()
    .from(marketplaceItems)
    .where(eq(marketplaceItems.id, id as any))
    .limit(1);
  return mapRow(rows[0]);
}

export async function listItems(opts: {
  kind?: MarketplaceKind;
  status?: MarketplaceStatus;
  limit?: number;
  offset?: number;
} = {}): Promise<MarketplaceItem[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;

  const conditions = [];
  if (opts.kind) conditions.push(eq(marketplaceItems.kind, opts.kind));
  if (opts.status) conditions.push(eq(marketplaceItems.status, opts.status));

  const rows = await db
    .select()
    .from(marketplaceItems)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(marketplaceItems.ratingAvg), desc(marketplaceItems.installCount))
    .limit(limit)
    .offset(offset);

  return rows.map(mapRow).filter((i): i is MarketplaceItem => i !== null);
}

// ───────────────────────────────────────────────
// Helpers.
// ───────────────────────────────────────────────

function mapRow(row: Record<string, unknown> | undefined): MarketplaceItem | null {
  if (!row) return null;
  return {
    id: row.id as string,
    kind: row.kind as MarketplaceKind,
    slug: row.slug as string,
    title: row.title as string,
    description: row.description as string,
    authorOrgId: (row.authorOrgId as string | null) ?? null,
    authorName: row.authorName as string,
    version: row.version as string,
    status: row.status as MarketplaceStatus,
    reviewType: row.reviewType as ReviewType,
    ratingAvg: Number(row.ratingAvg ?? 0),
    ratingCount: row.ratingCount as number,
    installCount: row.installCount as number,
    revenueSharePct: Number(row.revenueSharePct ?? 70),
    manifest: (row.manifest as Record<string, unknown>) ?? {},
    tags: (row.tags as string[]) ?? [],
    publishedAt: (row.publishedAt as Date | null) ?? null,
    createdAt: row.createdAt as Date,
  };
}

async function auditMarketplace(action: string, itemId: string, target: Record<string, unknown>): Promise<void> {
  try {
    await adminAudit({ actor: "system", action, target: { itemId, ...target }, justification: `marketplace: ${action}` });
  } catch { /* audit failure must not fail the operation */ }
}
