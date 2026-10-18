// ─────────────────────────────────────────────────────────────
// Catalog: local-first template browser.
//
// Full index (~2KB compressed per template meta: id, name, tags, sizeHint,
// thumbnail SVG string) shipped in the initial bundle as a versioned
// snapshot; refresh via background sync with a delta endpoint (since cursor).
//
// Thumbnails are the rendered SVG at 240px — reuse design-render, so
// catalog previews are pixel-identical to what you get on open.
//
// Search: client-side over name+tags with ranked scoring
// (exact name > tag > fuzzy); server search arrives in a later phase
// behind the same interface.
// ─────────────────────────────────────────────────────────────

import type { DesignTemplate } from "./types";

// ============ TEMPLATE META ============

export interface TemplateMeta {
  id: string;
  version: number;
  name: string;
  tags: string[];
  sizeHint: { width: number; height: number; name: string };
  /** Pre-rendered SVG thumbnail at 240px (from design-render). */
  thumbnailSvg: string;
  /** Catalog snapshot version (for delta sync). */
  catalogVersion: number;
}

// ============ CATALOG SOURCE ============

export interface CatalogSource {
  /** Lists template metadata (paginated via cursor). */
  list(cursor?: string): Promise<{ items: TemplateMeta[]; next?: string }>;
  /** Fetches the full template body (fetched on open — bundle ships metas, not bodies). */
  get(id: string): Promise<DesignTemplate>;
  /** Delta sync: fetches only metas updated since the cursor. */
  delta(since: number, cursor?: string): Promise<{ items: TemplateMeta[]; next?: string; version: number }>;
}

// ============ IN-MEMORY CATALOG SOURCE ============

/**
 * In-memory catalog source — used for tests + initial bundle.
 * The real implementation fetches from a CDN/API.
 */
export class InMemoryCatalogSource implements CatalogSource {
  private metas = new Map<string, TemplateMeta>();
  private templates = new Map<string, DesignTemplate>();
  private version = 1;

  add(template: DesignTemplate, thumbnailSvg: string): void {
    const meta: TemplateMeta = {
      id: template.id,
      version: template.version,
      name: template.name,
      tags: template.tags,
      sizeHint: template.sizeHint,
      thumbnailSvg,
      catalogVersion: this.version,
    };
    this.metas.set(template.id, meta);
    this.templates.set(template.id, template);
    this.version++;
  }

  list(cursor?: string): Promise<{ items: TemplateMeta[]; next?: string }> {
    const all = Array.from(this.metas.values()).sort((a, b) => a.name.localeCompare(b.name));

    // Simple cursor: offset-based.
    const offset = cursor ? parseInt(cursor, 10) || 0 : 0;
    const PAGE = 50;
    const items = all.slice(offset, offset + PAGE);
    const next = offset + PAGE < all.length ? String(offset + PAGE) : undefined;

    return Promise.resolve({ items, next });
  }

  get(id: string): Promise<DesignTemplate> {
    const template = this.templates.get(id);
    if (!template) return Promise.reject(new Error(`template_not_found: ${id}`));
    return Promise.resolve(structuredClone(template));
  }

  delta(since: number, cursor?: string): Promise<{ items: TemplateMeta[]; next?: string; version: number }> {
    const all = Array.from(this.metas.values())
      .filter((m) => m.catalogVersion > since)
      .sort((a, b) => a.catalogVersion - b.catalogVersion);

    const offset = cursor ? parseInt(cursor, 10) || 0 : 0;
    const PAGE = 100;
    const items = all.slice(offset, offset + PAGE);
    const next = offset + PAGE < all.length ? String(offset + PAGE) : undefined;

    return Promise.resolve({ items, next, version: this.version });
  }
}

// ============ CLIENT-SIDE SEARCH ============

export interface SearchResult {
  meta: TemplateMeta;
  score: number;
  /** Which field matched (for highlighting). */
  matchedField: "name" | "tag" | "fuzzy";
}

/**
 * Client-side search over template metadata.
 *
 * Ranked scoring:
 *   - Exact name match: score 100
 *   - Name starts with query: score 80
 *   - Name contains query: score 60
 *   - Exact tag match: score 40
 *   - Tag contains query: score 20
 *   - Fuzzy name match (trigram): score 10
 *
 * @example
 *   const results = searchCatalog(metas, "insta");
 *   // → [{ meta, score: 80, matchedField: "name" }, ...]
 */
export function searchCatalog(metas: TemplateMeta[], query: string): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];

  const results: SearchResult[] = [];

  for (const meta of metas) {
    const name = meta.name.toLowerCase();
    const tags = meta.tags.map((t) => t.toLowerCase());

    let score = 0;
    let matchedField: SearchResult["matchedField"] = "fuzzy";

    // Exact name match.
    if (name === q) {
      score = 100;
      matchedField = "name";
    }
    // Name starts with query.
    else if (name.startsWith(q)) {
      score = 80;
      matchedField = "name";
    }
    // Name contains query.
    else if (name.includes(q)) {
      score = 60;
      matchedField = "name";
    }
    // Exact tag match.
    else if (tags.includes(q)) {
      score = 40;
      matchedField = "tag";
    }
    // Tag contains query.
    else if (tags.some((t) => t.includes(q))) {
      score = 20;
      matchedField = "tag";
    }
    // Fuzzy name match (trigram similarity).
    else {
      const sim = trigramSimilarity(name, q);
      if (sim > 0.3) {
        score = Math.round(sim * 10);
        matchedField = "fuzzy";
      }
    }

    if (score > 0) {
      results.push({ meta, score, matchedField });
    }
  }

  // Sort by score descending, then by name.
  results.sort((a, b) => b.score - a.score || a.meta.name.localeCompare(b.meta.name));

  return results;
}

// ============ HELPERS ============

/**
 * Trigram similarity (Jaccard) between two strings.
 * Used for fuzzy name matching in catalog search.
 */
function trigramSimilarity(a: string, b: string): number {
  if (a.length < 3 || b.length < 3) return 0;

  const trigramsA = new Set<string>();
  for (let i = 0; i < a.length - 2; i++) {
    trigramsA.add(a.slice(i, i + 3));
  }

  const trigramsB = new Set<string>();
  for (let i = 0; i < b.length - 2; i++) {
    trigramsB.add(b.slice(i, i + 3));
  }

  let intersection = 0;
  for (const t of trigramsA) {
    if (trigramsB.has(t)) intersection++;
  }

  const union = trigramsA.size + trigramsB.size - intersection;
  return union > 0 ? intersection / union : 0;
}
