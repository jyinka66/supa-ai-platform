/**
 * @supa/design-marketplace/discovery
 * ----------------------------------------------------------------
 * Search index over meta + tokens + categories; the differentiator:
 * "remix" as the primary verb. Every template listing shows
 * community derivatives (installs fork, so lineage is real data —
 * provenance chain: template → fork → remix). Remix counts, not
 * raw installs, rank the index — installs measure downloads,
 * remixes measure usefulness.
 *
 * Personalization: cold-start by onboarding picks; after that,
 * ranking uses the user's own token palette/style clusters —
 * on-device features only, nothing about doc CONTENT leaves the
 * client for ranking (telemetry's privacy line extended here).
 * ----------------------------------------------------------------
 */

import type { TemplateMeta, TemplateCategory } from "./template-package.js";

// ───────────────────────────────────────────────
// Search index entry
// ───────────────────────────────────────────────

export interface SearchIndexEntry {
  meta: TemplateMeta;
  /** Remix count — the primary ranking signal. */
  remixCount: number;
  /** Install count — secondary signal. */
  installCount: number;
  /** Token ids used by this template (for style-cluster matching). */
  tokenIds: string[];
  /** Token values (resolved, for on-device personalization). */
  tokenValues: Record<string, string>;
  /** Lineage depth (0 = original, 1 = fork of original, etc.). */
  lineageDepth: number;
}

// ───────────────────────────────────────────────
// Search query
// ───────────────────────────────────────────────

export interface SearchQuery {
  /** Free-text query (matched against name + description). */
  text?: string;
  /** Category filter. */
  categories?: TemplateCategory[];
  /** Max lineage depth (0 = originals only, 1 = +1 level of forks). */
  maxLineageDepth?: number;
  /** Limit (default 20). */
  limit?: number;
}

// ───────────────────────────────────────────────
// Personalization — on-device features only
// ───────────────────────────────────────────────

/**
 * Personalization features computed on-device from the user's own
 * token palette. NOTHING about doc CONTENT leaves the client for
 * ranking — telemetry's privacy line extended here.
 *
 * The features are:
 *   - dominant color families (top-3 by frequency in the user's tokens)
 *   - preferred space scale (median space value)
 *   - preferred radius style (sharp/rounded/pill, by median)
 *
 * These are matched against template token values to rank results.
 * Doc content (what the user is designing) never enters ranking.
 */
export interface UserStyleFeatures {
  /** Top-3 dominant color families (e.g. ["blue", "neutral", "accent"]). */
  dominantColorFamilies: string[];
  /** Preferred space scale (median px). */
  preferredSpaceScale: number;
  /** Preferred radius style. */
  preferredRadiusStyle: "sharp" | "rounded" | "pill";
}

export interface PersonalizationContext {
  /** Cold-start: use onboarding picks if no user features yet. */
  onboardingPicks?: TemplateCategory[];
  /** User features (computed on-device). */
  userFeatures?: UserStyleFeatures;
}

// ───────────────────────────────────────────────
// Search index
// ───────────────────────────────────────────────

/**
 * In-memory search index. Production uses a real search engine
 * (Meilisearch, Typesense, or Postgres FTS); this is the contract
 * and a reference impl for tests.
 *
 * Ranking signals (in priority order):
 *   1. Remix count (the primary verb — measures usefulness)
 *   2. Personalization match (on-device features)
 *   3. Install count (secondary)
 *   4. Lineage depth (originals rank higher than deep forks)
 */
export class TemplateSearchIndex {
  private readonly entries = new Map<string, SearchIndexEntry>();

  upsert(entry: SearchIndexEntry): void {
    this.entries.set(entry.meta.id, entry);
  }

  remove(templateId: string): void {
    this.entries.delete(templateId);
  }

  /** Increment remix count (called when a fork is published). */
  incrementRemixCount(templateId: string): void {
    const entry = this.entries.get(templateId);
    if (entry) {
      this.entries.set(templateId, { ...entry, remixCount: entry.remixCount + 1 });
    }
  }

  /** Increment install count (called when a template is installed). */
  incrementInstallCount(templateId: string): void {
    const entry = this.entries.get(templateId);
    if (entry) {
      this.entries.set(templateId, { ...entry, installCount: entry.installCount + 1 });
    }
  }

  search(query: SearchQuery, personalization?: PersonalizationContext): SearchIndexEntry[] {
    let results = [...this.entries.values()];

    // Filter by text query (name + description, any language).
    if (query.text) {
      const q = query.text.toLowerCase();
      results = results.filter((e) =>
        Object.values(e.meta.name).some((n) => n.toLowerCase().includes(q)) ||
        Object.values(e.meta.description).some((d) => d.toLowerCase().includes(q)) ||
        e.meta.categories.some((c) => c.toLowerCase().includes(q)),
      );
    }

    // Filter by category.
    if (query.categories && query.categories.length > 0) {
      results = results.filter((e) =>
        query.categories!.some((c) => e.meta.categories.includes(c)),
      );
    }

    // Filter by lineage depth.
    if (query.maxLineageDepth !== undefined) {
      results = results.filter((e) => e.lineageDepth <= query.maxLineageDepth!);
    }

    // Rank: remix count > personalization match > install count > lineage depth.
    results.sort((a, b) => {
      // Primary: remix count (descending).
      if (a.remixCount !== b.remixCount) return b.remixCount - a.remixCount;

      // Secondary: personalization match (higher = better).
      if (personalization?.userFeatures) {
        const aMatch = computePersonalizationMatch(a, personalization.userFeatures);
        const bMatch = computePersonalizationMatch(b, personalization.userFeatures);
        if (aMatch !== bMatch) return bMatch - aMatch;
      } else if (personalization?.onboardingPicks) {
        // Cold-start: rank by category match with onboarding picks.
        const aMatch = a.meta.categories.filter((c) => personalization.onboardingPicks!.includes(c)).length;
        const bMatch = b.meta.categories.filter((c) => personalization.onboardingPicks!.includes(c)).length;
        if (aMatch !== bMatch) return bMatch - aMatch;
      }

      // Tertiary: install count (descending).
      if (a.installCount !== b.installCount) return b.installCount - a.installCount;

      // Quaternary: lineage depth (originals rank higher).
      return a.lineageDepth - b.lineageDepth;
    });

    const limit = query.limit ?? 20;
    return results.slice(0, limit);
  }
}

// ───────────────────────────────────────────────
// Personalization match scoring
// ───────────────────────────────────────────────

/**
 * Score how well a template matches the user's on-device style features.
 *
 * Score is 0..100, higher = better match. Computed entirely on-device
 * from the template's token values — no doc content leaves the client.
 */
export function computePersonalizationMatch(
  entry: SearchIndexEntry,
  features: UserStyleFeatures,
): number {
  let score = 0;

  // Color family match (top-3 dominant).
  // ANY match between template colors and user's top-3 families is a
  // strong signal (the user has multiple families; one match means
  // the template's palette is in their wheelhouse). Full 50 pts for
  // any overlap.
  const templateColors = Object.values(entry.tokenValues).filter((v) => v.startsWith("#"));
  if (templateColors.length > 0) {
    const templateFamilies = new Set(
      templateColors.map((c) => colorFamily(c)).filter(Boolean),
    );
    const overlap = features.dominantColorFamilies.filter((f) => templateFamilies.has(f)).length;
    if (overlap > 0) {
      score += 50;
    }
  }

  // Space scale match (within ±4px of preferred).
  const templateSpaces = Object.entries(entry.tokenValues)
    .filter(([k]) => k.startsWith("space."))
    .map(([, v]) => parseFloat(v))
    .filter((n) => !Number.isNaN(n));
  if (templateSpaces.length > 0) {
    const medianSpace = median(templateSpaces);
    const diff = Math.abs(medianSpace - features.preferredSpaceScale);
    if (diff <= 4) score += 25;
    else if (diff <= 8) score += 12;
  }

  // Radius style match.
  const templateRadii = Object.entries(entry.tokenValues)
    .filter(([k]) => k.startsWith("radius."))
    .map(([, v]) => parseFloat(v))
    .filter((n) => !Number.isNaN(n));
  if (templateRadii.length > 0) {
    const medianRadius = median(templateRadii);
    const templateRadiusStyle: UserStyleFeatures["preferredRadiusStyle"] =
      medianRadius < 2 ? "sharp" : medianRadius < 12 ? "rounded" : "pill";
    if (templateRadiusStyle === features.preferredRadiusStyle) score += 25;
  }

  return score;
}

// ───────────────────────────────────────────────
// Lineage — provenance chain
// ───────────────────────────────────────────────

/**
 * Installs fork, so lineage is real data. Every template listing
 * shows community derivatives — the provenance chain: template →
 * fork → remix.
 */
export interface LineageNode {
  templateId: string;
  derivedFrom: string | null;
}

export function computeLineageDepth(
  templateId: string,
  lineage: LineageNode[],
): number {
  const byId = new Map(lineage.map((n) => [n.templateId, n]));
  let depth = 0;
  let current = byId.get(templateId);
  // Cycle guard: cap at 100. Check BEFORE incrementing so we never
  // exceed the cap (a cycle returns exactly 100, not 101).
  while (current && current.derivedFrom) {
    if (depth >= 100) break;
    depth++;
    current = byId.get(current.derivedFrom);
  }
  return depth;
}

export function computeDerivatives(
  templateId: string,
  lineage: LineageNode[],
): string[] {
  return lineage
    .filter((n) => n.derivedFrom === templateId)
    .map((n) => n.templateId);
}

// ───────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────

function colorFamily(hex: string): string | null {
  const h = hex.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  // Cheap hue classification.
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 30) return "neutral";
  if (r >= g && r >= b) return r - b > 50 && r - g > 50 ? "red" : "orange";
  if (g >= r && g >= b) return "green";
  if (b >= r && b >= g) return g > r ? "cyan" : "blue";
  return "accent";
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}
