// Marketplace repository — DB-backed persistence for Supa OS marketplace items.
//
// Replaces the in-memory `itemStore` array in
// `app/api/supa-os/marketplace/route.ts`.

import { getSystemPool, withSystem } from "@supa/db";
import type {
  MarketplaceItem, MarketplaceItemType, MonetizationModel, ReviewCheck,
} from "@/lib/supa-os/marketplace";

type Row = Record<string, unknown>;
type Filter = { q?: string; type?: MarketplaceItemType; tags?: string[]; monetization?: MonetizationModel; verifiedOnly?: boolean };

function whereFor(query: Filter): { clause: string; values: unknown[] } {
  const clauses = ["status = 'published'"];
  const values: unknown[] = [];
  const add = (clause: (placeholder: string) => string, value: unknown) => { values.push(value); clauses.push(clause(`$${values.length}`)); };
  if (query.q?.trim()) add((p) => `(name ilike ${p} or description ilike ${p} or exists (select 1 from unnest(tags) t where t ilike ${p}))`, `%${query.q.trim().slice(0, 120)}%`);
  if (query.type) add((p) => `type = ${p}`, query.type);
  if (query.monetization) add((p) => `monetization = ${p}`, query.monetization);
  if (query.verifiedOnly) clauses.push("verified = true");
  if (query.tags?.length) {
    const tags = query.tags.slice(0, 20);
    const placeholders = tags.map((tag) => { values.push(tag); return `$${values.length}`; });
    clauses.push(`tags && ARRAY[${placeholders.join(",")}]::text[]`);
  }
  return { clause: clauses.join(" and "), values };
}

export async function getDeveloperOrgForOwner(userId: string, orgId?: string): Promise<{ id: string; name: string } | null> {
  const rows = await withSystem(getSystemPool(), async (tx) => await tx.unsafe<Row[]>(`select id,name from developer_orgs where owner_user_id=$1::uuid and status='active' and ($2::uuid is null or id=$2::uuid) order by created_at asc limit 1`, [userId, orgId ?? null]));
  const row = rows[0];
  return row ? { id: String(row.id), name: String(row.name) } : null;
}

export async function insertItem(item: MarketplaceItem, checks: ReviewCheck[] = []): Promise<MarketplaceItem> {
  await withSystem(getSystemPool(), async (tx) => {
    await tx.unsafe(`insert into supa_os_marketplace_items
      (id,name,type,description,creator_id,creator_name,status,monetization,price,version,tags,manifest,download_count,rating,review_count,featured,verified,published_at,created_at,updated_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text[],$12::jsonb,$13,$14,$15,$16,$17,$18,$19,$20)`, [
      item.id, item.name, item.type, item.description, item.creatorId, item.creatorName, item.status, item.monetization, item.price, item.version,
      tx.array(item.tags), JSON.stringify(item.manifest ?? {}), item.downloadCount, item.rating, item.reviewCount, item.featured, item.verified, item.publishedAt, item.createdAt, item.updatedAt,
    ]);
    await tx.unsafe(`insert into supa_os_marketplace_item_checks (item_id, checks) values ($1::uuid, $2::jsonb)`, [item.id, JSON.stringify(checks)]);
  });
  return item;
}

export async function getItem(itemId: string): Promise<MarketplaceItem | null> {
  const rows = await withSystem(getSystemPool(), async (tx) => await tx.unsafe<Row[]>(`select id,name,type,description,creator_id,creator_name,status,monetization,price,version,tags,manifest,download_count,rating,review_count,featured,verified,published_at,created_at,updated_at from supa_os_marketplace_items where id = $1::uuid limit 1`, [itemId]));
  return rows[0] ? mapRowToItem(rows[0]) : null;
}

export async function incrementDownload(itemId: string): Promise<MarketplaceItem | null> {
  const rows = await withSystem(getSystemPool(), async (tx) => await tx.unsafe<Row[]>(`update supa_os_marketplace_items set download_count=download_count+1 where id=$1::uuid and status='published' returning id,name,type,description,creator_id,creator_name,status,monetization,price,version,tags,manifest,download_count,rating,review_count,featured,verified,published_at,created_at,updated_at`, [itemId]));
  return rows[0] ? mapRowToItem(rows[0]) : null;
}

export async function countItems(query: Filter = {}): Promise<number> {
  const { clause, values } = whereFor(query);
  const rows = await withSystem(getSystemPool(), async (tx) => await tx.unsafe<Row[]>(`select count(*)::int as count from supa_os_marketplace_items where ${clause}`, values as never));
  return Number(rows[0]?.count ?? 0);
}

export async function listItems(query: Filter & { sort?: "trending" | "newest" | "top_rated" | "most_downloaded" | "featured"; limit?: number; offset?: number }): Promise<MarketplaceItem[]> {
  const { clause, values } = whereFor(query);
  const order = query.sort === "newest" ? "published_at desc nulls last" :
    query.sort === "top_rated" ? "rating desc, review_count desc" :
    query.sort === "most_downloaded" ? "download_count desc" :
    query.sort === "featured" ? "featured desc, published_at desc nulls last" :
    "(rating * ln(download_count + 1)) desc, published_at desc nulls last";
  const limit = Math.max(1, Math.min(100, Math.floor(query.limit ?? 24)));
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  const params = [...values, limit, offset];
  const rows = await withSystem(getSystemPool(), async (tx) => await tx.unsafe<Row[]>(`select id,name,type,description,creator_id,creator_name,status,monetization,price,version,tags,download_count,rating,review_count,featured,verified,published_at,created_at,updated_at from supa_os_marketplace_items where ${clause} order by ${order} limit $${values.length + 1} offset $${values.length + 2}`, params as never));
  return rows.map(mapRowToItem);
}

export async function updateItem(item: MarketplaceItem): Promise<MarketplaceItem> {
  await withSystem(getSystemPool(), async (tx) => {
    await tx.unsafe(`update supa_os_marketplace_items set name=$2,description=$3,status=$4,monetization=$5,price=$6,version=$7,tags=$8::text[],manifest=$9::jsonb,download_count=$10,rating=$11,review_count=$12,featured=$13,verified=$14,published_at=$15,updated_at=now() where id=$1::uuid`, [item.id,item.name,item.description,item.status,item.monetization,item.price,item.version,tx.array(item.tags),JSON.stringify(item.manifest ?? {}),item.downloadCount,item.rating,item.reviewCount,item.featured,item.verified,item.publishedAt]);
  });
  return item;
}

export async function hasDuplicateManifest(item: MarketplaceItem): Promise<boolean> {
  const manifest = JSON.stringify(item.manifest ?? {});
  const rows = await withSystem(getSystemPool(), async (tx) => await tx.unsafe<Row[]>(`select exists(select 1 from supa_os_marketplace_items where id <> $1::uuid and status in ('published','in_review','approved') and manifest = $2::jsonb) as duplicate`, [item.id, manifest]));
  return rows[0]?.duplicate === true;
}

export async function recordReview(input: { itemId: string; reviewerId: string; decision: "approve" | "reject"; notes: string; reviewChecks: ReviewCheck[] }): Promise<void> {
  await withSystem(getSystemPool(), async (tx) => {
    await tx.unsafe(`insert into supa_os_marketplace_reviews (item_id,reviewer_id,decision,notes,review_checks) values ($1::uuid,$2,$3,$4,$5::jsonb)`, [input.itemId,input.reviewerId,input.decision,input.notes,JSON.stringify(input.reviewChecks)]);
  });
}

/** Atomically update publication state and append the manual review history. */
export async function persistReview(input: { item: MarketplaceItem; reviewerId: string; decision: "approve" | "reject"; notes: string; reviewChecks: ReviewCheck[] }): Promise<MarketplaceItem> {
  await withSystem(getSystemPool(), async (tx) => {
    const updated = await tx.unsafe<Row[]>(`update supa_os_marketplace_items set status=$2,verified=$3,published_at=$4,updated_at=now() where id=$1::uuid and status='in_review' returning id`, [input.item.id,input.item.status,input.item.verified,input.item.publishedAt]);
    if (!updated.length) throw new Error("Marketplace item no longer exists");
    await tx.unsafe(`insert into supa_os_marketplace_reviews (item_id,reviewer_id,decision,notes,review_checks) values ($1::uuid,$2,$3,$4,$5::jsonb)`, [input.item.id,input.reviewerId,input.decision,input.notes,JSON.stringify(input.reviewChecks)]);
    await tx.unsafe(`insert into supa_os_marketplace_item_checks (item_id,checks,checked_at) values ($1::uuid,$2::jsonb,now()) on conflict (item_id) do update set checks=excluded.checks, checked_at=excluded.checked_at`, [input.item.id,JSON.stringify(input.reviewChecks)]);
  });
  return input.item;
}

// ───────────────────────────────────────────────
// Helper: map a DB row to a MarketplaceItem.
// ───────────────────────────────────────────────

function mapRowToItem(row: Record<string, unknown>): MarketplaceItem {
  return {
    id: row.id as string,
    name: row.name as string,
    type: row.type as MarketplaceItemType,
    description: row.description as string,
    creatorId: row.creator_id as string,
    creatorName: row.creator_name as string,
    status: row.status as MarketplaceItem["status"],
    monetization: row.monetization as MonetizationModel,
    price: Number(row.price),
    version: row.version as string,
    tags: (row.tags as string[]) ?? [],
    manifest: (row.manifest as Record<string, unknown>) ?? {},
    downloadCount: row.download_count as number,
    rating: Number(row.rating),
    reviewCount: row.review_count as number,
    featured: row.featured as boolean,
    verified: row.verified as boolean,
    publishedAt: row.published_at ? new Date(row.published_at as string) : null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  } as MarketplaceItem;
}
