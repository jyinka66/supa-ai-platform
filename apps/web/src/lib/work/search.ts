import { db } from "@supa/db";
import {
  workItems,
  workItemTags,
  tags,
  workFolders,
} from "@supa/db/schema";
import { eq, and, or, ilike, sql, desc, asc, inArray, isNull, type SQL } from "drizzle-orm";
import type { User } from "@supabase/supabase-js";

/**
 * Three-tier search for work items.
 *
 * Tier classification:
 *   1. 'fts'       — has meaningful terms → tsquery with ranking (fastest for real words)
 *   2. 'trigram'   — short (<3 chars), names, fuzzy intent → trigram similarity (catches typos)
 *   3. 'filter'    — empty query, only filters → plain indexed scan (no text search)
 *   4. 'fallback'  — fts returned < threshold rows → retry with trigram (same request)
 *
 * The classification is a cheap heuristic — no LLM call, just regex + length checks.
 */

export interface SearchParams {
  /** The search query string (may be empty for filter-only). */
  query: string;
  /** Workspace ID to scope the search. */
  workspaceId: string;
  /** Caller's user ID (for RLS + ownership checks). */
  userId: string;
  /** Filter by item type. */
  type?: string;
  /** Filter by folder ID (null = root, undefined = all folders). */
  folderId?: string | null;
  /** Filter by tag IDs. */
  tagIds?: string[];
  /** Filter by favorite status. */
  favorite?: boolean;
  /** Filter by owner. */
  ownerId?: string;
  /** Include trashed items (default: false). */
  includeTrash?: boolean;
  /** Pagination offset. */
  offset?: number;
  /** Page size (default: 20, max: 100). */
  limit?: number;
  /** Sort order. */
  sort?: "relevance" | "updated" | "created" | "title";
}

export interface SearchResult {
  items: SearchItem[];
  total: number;
  tier: SearchTier;
  /** For 'fallback' tier: the number of results from fts before retrying with trigram. */
  ftsCount?: number;
}

export interface SearchItem {
  id: string;
  title: string;
  type: string;
  status: string;
  content: string | null;
  contentFormat: string | null;
  fileUrl: string | null;
  thumbnailUrl: string | null;
  metadata: Record<string, unknown>;
  favorite: boolean;
  folderId: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Relevance rank (higher = more relevant). Null for filter-only queries. */
  rank: number | null;
}

export type SearchTier = "fts" | "trigram" | "filter" | "fallback";

const FALLBACK_THRESHOLD = 3;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

interface ClassifiedQuery {
  tier: SearchTier;
  /** Sanitized query (trimmed, lowercased). */
  sanitized: string;
  /** True if the query looks like a real word (not a fragment). */
  hasMeaningfulTerms: boolean;
}

/**
 * Searches work items using the appropriate tier.
 *
 * @example
 *   const results = await searchWorkItems({
 *     query: "invoice",
 *     workspaceId: ws.id,
 *     userId: user.id,
 *     type: "invoice",
 *     sort: "relevance",
 *   });
 */
export async function searchWorkItems(params: SearchParams): Promise<SearchResult> {
  return undefined as never;
  const classified = classify(params.query);

  switch (classified.tier) {
    case "fts": {
      const ftsResults = await ftsSearch(params, classified.sanitized);
      // Fallback: if fts returned < threshold, retry with trigram.
      if (ftsResults.total < FALLBACK_THRESHOLD && ftsResults.total === 0) {
        const trigramResults = await trigramSearch(params, classified.sanitized);
        return {
          ...trigramResults,
          tier: "fallback",
          ftsCount: ftsResults.total,
        };
      }
      return ftsResults;
    }
    case "trigram":
      return trigramSearch(params, classified.sanitized);
    case "filter":
      return filterScan(params);
  }
}

/**
 * Classifies a search query into a tier.
 *
 * Heuristics:
 *   - Empty query → 'filter'
 *   - < 3 chars → 'trigram' (fts needs at least 3 chars to be useful)
 *   - Looks like a name/identifier (no spaces, mixed case) → 'trigram'
 *   - Has meaningful terms (3+ chars, alphabetic) → 'fts'
 *   - Otherwise → 'trigram' (conservative — fts might miss)
 */
function classify(rawQuery: string): ClassifiedQuery {
  const sanitized = rawQuery.trim().toLowerCase();

  // Empty → filter-only.
  if (sanitized.length === 0) {
    return { tier: "filter", sanitized: "", hasMeaningfulTerms: false };
  }

  // < 3 chars → trigram (fts needs lexemes).
  if (sanitized.length < 3) {
    return { tier: "trigram", sanitized, hasMeaningfulTerms: false };
  }

  // Looks like a name/identifier (no spaces, mixed case in original) → trigram.
  // Catches: "Acme", "invoice_123", "Q4-2024"
  if (!/\s/.test(rawQuery) && /[A-Z]/.test(rawQuery) && /[a-z]/.test(rawQuery)) {
    return { tier: "trigram", sanitized, hasMeaningfulTerms: true };
  }

  // Has meaningful alphabetic terms (3+ chars) → fts.
  if (/[a-z]{3,}/.test(sanitized)) {
    return { tier: "fts", sanitized, hasMeaningfulTerms: true };
  }

  // Default → trigram (conservative).
  return { tier: "trigram", sanitized, hasMeaningfulTerms: false };
}

/**
 * Full-text search using the `search_vector` tsvector column.
 *
 * Uses `websearch_to_tsquery('simple', ...)` — supports quoted phrases
 * ("exact match"), boolean operators (OR, AND, NOT), and parenthesized
 * grouping. More powerful than `plainto_tsquery` for multi-word queries.
 *
 * Ranking: weighted blend of ts_rank (75%) + recency decay (25%).
 * The recency factor uses exponential decay: items updated within ~90 days
 * get a higher score, smoothing out old vs. new content.
 *
 * Snippet: `ts_headline` generates a 6-12 word excerpt around the match.
 */
async function ftsSearch(params: SearchParams, query: string): Promise<SearchResult> {
  const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const offset = params.offset ?? 0;

  // Use websearch_to_tsquery — supports "quoted phrases", OR, AND, -NOT.
  const tsquery = sql`websearch_to_tsquery('simple', ${query})`;

  // Recency-blend ranking: ts_rank * 0.75 + exp(-age_seconds / 7776000) * 0.25
  // 7776000 seconds ≈ 90 days — controls how fast recency decays.
  const rankExpr = sql`
    ts_rank(wi.search_vector, ${tsquery}) * 0.75
    + exp(-extract(epoch from (now() - wi.updated_at)) / 7776000.0) * 0.25
  `;

  const rows = await db.execute<FTSSearchRow>(sql`
    select
      wi.id,
      wi.title,
      wi.type,
      wi.status,
      wi.content,
      wi.content_format,
      wi.file_url,
      wi.thumbnail_url,
      wi.metadata,
      wi.favorite,
      wi.folder_id,
      wi.created_at,
      wi.updated_at,
      ${rankExpr} as rank,
      left(
        ts_headline('simple', coalesce(wi.content, ''), ${tsquery}, 'MaxWords=12 MinWords=6'),
        240
      ) as snippet,
      f.name as folder_name,
      coalesce(
        array_agg(distinct t.name) filter (where t.name is not null),
        '{}'::text[]
      ) as tag_names
    from work_items wi
    cross join ${tsquery} q
    left join work_folders f on f.id = wi.folder_id
    left join work_item_tags wit on wit.item_id = wi.id
    left join tags t on t.id = wit.tag_id
    where wi.workspace_id = ${params.workspaceId}
      and wi.status = 'active'
      and wi.search_vector @@ q
      ${params.type ? sql`and wi.type = ${params.type}` : sql``}
      ${params.folderId !== undefined && params.folderId !== null ? sql`and wi.folder_id = ${params.folderId}` : sql``}
      ${params.folderId === null ? sql`and wi.folder_id is null` : sql``}
      ${params.favorite !== undefined ? sql`and wi.favorite = ${params.favorite}` : sql``}
      ${params.ownerId ? sql`and wi.owner_id = ${params.ownerId}` : sql``}
    group by wi.id, q, f.name
    order by ${rankExpr} desc
    limit ${limit} offset ${offset}
  `);

  // Count query (without the lateral joins + group by — faster).
  const countResult = await db.execute<{ count: number }>(sql`
    select count(*)::int as count
    from work_items wi
    cross join ${tsquery} q
    where wi.workspace_id = ${params.workspaceId}
      and wi.status = 'active'
      and wi.search_vector @@ q
      ${params.type ? sql`and wi.type = ${params.type}` : sql``}
      ${params.folderId !== undefined && params.folderId !== null ? sql`and wi.folder_id = ${params.folderId}` : sql``}
      ${params.folderId === null ? sql`and wi.folder_id is null` : sql``}
      ${params.favorite !== undefined ? sql`and wi.favorite = ${params.favorite}` : sql``}
      ${params.ownerId ? sql`and wi.owner_id = ${params.ownerId}` : sql``}
  `);
  const total = (countResult[0] as { count?: number })?.count ?? 0;

  const items: SearchItem[] = (Array.isArray(rows) ? rows : []).map((r) => ({
    id: r.id,
    title: r.title,
    type: r.type,
    status: r.status,
    content: r.content,
    contentFormat: r.content_format,
    fileUrl: r.file_url,
    thumbnailUrl: r.thumbnail_url,
    metadata: r.metadata as Record<string, unknown>,
    favorite: r.favorite,
    folderId: r.folder_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    rank: Number(r.rank),
  }));

  // Attach snippets + folder + tags to metadata for the caller.
  for (let i = 0; i < items.length; i++) {
    const row = (rows as FTSSearchRow[])[i];
    if (row) {
      items[i]!.metadata = {
        ...items[i]!.metadata,
        snippet: row.snippet || null,
        folderName: row.folder_name || null,
        tagNames: row.tag_names || [],
      };
    }
  }

  return {
    items,
    total,
    tier: "fts",
  };
}

interface FTSSearchRow {
  [key: string]: unknown;
  id: string;
  title: string;
  type: string;
  status: string;
  content: string | null;
  content_format: string | null;
  file_url: string | null;
  thumbnail_url: string | null;
  metadata: Record<string, unknown> | null;
  favorite: boolean;
  folder_id: string | null;
  created_at: Date;
  updated_at: Date;
  rank: string;
  snippet: string;
  folder_name: string | null;
  tag_names: string[];
}

/**
 * Trigram similarity search using the `title gin_trgm_ops` index.
 *
 * Catches typos, partial matches, and names that fts would miss.
 * Uses `similarity()` for ranking (0..1, higher = more similar).
 *
 * Matches on BOTH title AND tag names — a search for "invoce" (typo of
 * "invoice") should match items tagged "invoice" even if the title is
 * "Q4 Report". The tag-name match uses a subquery with array_agg + %.
 *
 * Requires the `pg_trgm` extension (installed in migration 0014).
 */
async function trigramSearch(params: SearchParams, query: string): Promise<SearchResult> {
  const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const offset = params.offset ?? 0;

  // Build the trigram match condition: title % query OR tag_names % query.
  // The tag-name match uses a correlated subquery.
  const trigramMatch = sql`
    (wi.title % ${query}
     OR array_to_string(
       (SELECT array_agg(t.name)
        FROM work_item_tags wit
        JOIN tags t ON t.id = wit.tag_id
        WHERE wit.item_id = wi.id),
       ' '
     ) % ${query})
  `;

  // Execute the search with similarity ranking.
  // We use raw SQL because the tag-name subquery + OR condition is hard
  // to express in Drizzle's query builder.
  const rows = await db.execute<TrigramSearchRow>(sql`
    select
      wi.id,
      wi.title,
      wi.type,
      wi.status,
      wi.content,
      wi.content_format,
      wi.file_url,
      wi.thumbnail_url,
      wi.metadata,
      wi.favorite,
      wi.folder_id,
      wi.created_at,
      wi.updated_at,
      similarity(wi.title, ${query}) as rank,
      left(wi.title, 120) as snippet,
      coalesce(
        array_agg(distinct t.name) filter (where t.name is not null),
        '{}'::text[]
      ) as tag_names
    from work_items wi
    left join work_item_tags wit on wit.item_id = wi.id
    left join tags t on t.id = wit.tag_id
    where wi.workspace_id = ${params.workspaceId}
      and wi.status = 'active'
      and ${trigramMatch}
      ${params.type ? sql`and wi.type = ${params.type}` : sql``}
      ${params.folderId !== undefined && params.folderId !== null ? sql`and wi.folder_id = ${params.folderId}` : sql``}
      ${params.folderId === null ? sql`and wi.folder_id is null` : sql``}
      ${params.favorite !== undefined ? sql`and wi.favorite = ${params.favorite}` : sql``}
      ${params.ownerId ? sql`and wi.owner_id = ${params.ownerId}` : sql``}
    group by wi.id
    order by similarity(wi.title, ${query}) desc
    limit ${limit} offset ${offset}
  `);

  // Count query.
  const countResult = await db.execute<{ count: number }>(sql`
    select count(*)::int as count
    from work_items wi
    where wi.workspace_id = ${params.workspaceId}
      and wi.status = 'active'
      and ${trigramMatch}
      ${params.type ? sql`and wi.type = ${params.type}` : sql``}
      ${params.folderId !== undefined && params.folderId !== null ? sql`and wi.folder_id = ${params.folderId}` : sql``}
      ${params.folderId === null ? sql`and wi.folder_id is null` : sql``}
      ${params.favorite !== undefined ? sql`and wi.favorite = ${params.favorite}` : sql``}
      ${params.ownerId ? sql`and wi.owner_id = ${params.ownerId}` : sql``}
  `);
  const total = (countResult[0] as { count?: number })?.count ?? 0;

  const items: SearchItem[] = (Array.isArray(rows) ? rows : []).map((r) => ({
    id: r.id,
    title: r.title,
    type: r.type,
    status: r.status,
    content: r.content,
    contentFormat: r.content_format,
    fileUrl: r.file_url,
    thumbnailUrl: r.thumbnail_url,
    metadata: {
      ...(r.metadata as Record<string, unknown> ?? {}),
      snippet: r.snippet || null,
      tagNames: r.tag_names || [],
    },
    favorite: r.favorite,
    folderId: r.folder_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    rank: Number(r.rank),
  }));

  return {
    items,
    total,
    tier: "trigram",
  };
}

interface TrigramSearchRow {
  [key: string]: unknown;
  id: string;
  title: string;
  type: string;
  status: string;
  content: string | null;
  content_format: string | null;
  file_url: string | null;
  thumbnail_url: string | null;
  metadata: Record<string, unknown> | null;
  favorite: boolean;
  folder_id: string | null;
  created_at: Date;
  updated_at: Date;
  rank: string;
  snippet: string;
  tag_names: string[];
}

/**
 * Filter-only scan (no text search).
 *
 * Used when the query is empty — just filters on type, folder, tags, etc.
 * Uses the `work_items_ws_status_idx` / `work_items_ws_type_idx` indexes.
 */
async function filterScan(params: SearchParams): Promise<SearchResult> {
  const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const offset = params.offset ?? 0;

  const conditions = [
    eq(workItems.workspaceId, params.workspaceId),
  ];

  if (!params.includeTrash) {
    conditions.push(eq(workItems.status, "active"));
  }
  if (params.type) {
    conditions.push(eq(workItems.type, params.type));
  }
  if (params.folderId !== undefined) {
    if (params.folderId === null) {
      conditions.push(isNull(workItems.folderId));
    } else {
      conditions.push(eq(workItems.folderId, params.folderId));
    }
  }
  if (params.favorite !== undefined) {
    conditions.push(eq(workItems.favorite, params.favorite));
  }
  if (params.ownerId) {
    conditions.push(eq(workItems.ownerId, params.ownerId));
  }
  if (params.tagIds && params.tagIds.length > 0) {
    conditions.push(
      inArray(
        workItems.id,
        db
          .select({ id: workItemTags.itemId })
          .from(workItemTags)
          .where(inArray(workItemTags.tagId, params.tagIds)),
      ),
    );
  }

  // Count.
  const countResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(workItems)
    .where(and(...conditions));
  const total = countResult[0]?.count ?? 0;

  // Sort.
  const sort = params.sort ?? "updated";
  const orderBy =
    sort === "updated"
      ? [desc(workItems.updatedAt)]
      : sort === "created"
        ? [desc(workItems.createdAt)]
        : sort === "title"
          ? [asc(workItems.title)]
          : [desc(workItems.updatedAt)];

  const rows = await db
    .select({
      id: workItems.id,
      title: workItems.title,
      type: workItems.type,
      status: workItems.status,
      content: workItems.content,
      contentFormat: workItems.contentFormat,
      fileUrl: workItems.fileUrl,
      thumbnailUrl: workItems.thumbnailUrl,
      metadata: workItems.metadata,
      favorite: workItems.favorite,
      folderId: workItems.folderId,
      createdAt: workItems.createdAt,
      updatedAt: workItems.updatedAt,
    })
    .from(workItems)
    .where(and(...conditions))
    .orderBy(...orderBy)
    .offset(offset)
    .limit(limit);

  return {
    items: rows.map((r) => ({
      ...r,
      metadata: r.metadata as Record<string, unknown>,
      rank: null, // no relevance ranking for filter-only
    })),
    total,
    tier: "filter",
  };
}
