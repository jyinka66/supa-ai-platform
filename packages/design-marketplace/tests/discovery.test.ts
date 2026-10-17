/**
 * Discovery tests.
 *
 * Covers:
 *   - remix count ranks higher than install count (remix is primary verb)
 *   - personalization match breaks ties
 *   - cold-start uses onboarding picks
 *   - lineage depth — originals rank higher than deep forks
 *   - text + category filters
 *   - personalization match scoring
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  TemplateSearchIndex,
  computePersonalizationMatch,
  computeLineageDepth,
  computeDerivatives,
  type SearchIndexEntry,
  type UserStyleFeatures,
} from "../src/discovery.js";
import type { TemplateMeta, TemplateCategory } from "../src/template-package.js";

// ───────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────

function makeMeta(id: string, cats: TemplateCategory[] = ["deck"]): TemplateMeta {
  return {
    id,
    semver: "1.0.0",
    author: "a",
    license: "MIT",
    categories: cats,
    preview: { thumbnails: [], animatedPreview: "" },
    name: { en: id },
    description: { en: "d" },
    aiAssisted: false,
  };
}

function makeEntry(
  id: string,
  opts: { remixCount?: number; installCount?: number; lineageDepth?: number; categories?: TemplateCategory[]; tokenValues?: Record<string, string> } = {},
): SearchIndexEntry {
  return {
    meta: makeMeta(id, opts.categories),
    remixCount: opts.remixCount ?? 0,
    installCount: opts.installCount ?? 0,
    tokenIds: [],
    tokenValues: opts.tokenValues ?? {},
    lineageDepth: opts.lineageDepth ?? 0,
  };
}

// ───────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────

describe("TemplateSearchIndex ranking", () => {
  let index: TemplateSearchIndex;

  beforeEach(() => {
    index = new TemplateSearchIndex();
  });

  it("remix count ranks higher than install count", () => {
    index.upsert(makeEntry("a", { remixCount: 10, installCount: 100 }));
    index.upsert(makeEntry("b", { remixCount: 50, installCount: 5 }));
    const results = index.search({ limit: 2 });
    expect(results[0]!.meta.id).toBe("b"); // more remixes → higher
    expect(results[1]!.meta.id).toBe("a");
  });

  it("personalization match breaks ties (same remix count)", () => {
    index.upsert(makeEntry("a", { remixCount: 10, tokenValues: { "brand.primary": "#1a1aff" } }));
    index.upsert(makeEntry("b", { remixCount: 10, tokenValues: { "brand.primary": "#ff0000" } }));
    const features: UserStyleFeatures = {
      dominantColorFamilies: ["blue"],
      preferredSpaceScale: 4,
      preferredRadiusStyle: "sharp",
    };
    const results = index.search({ limit: 2 }, { userFeatures: features });
    expect(results[0]!.meta.id).toBe("a"); // matches blue family
  });

  it("cold-start uses onboarding picks (category match)", () => {
    index.upsert(makeEntry("a", { remixCount: 10, categories: ["poster"] }));
    index.upsert(makeEntry("b", { remixCount: 10, categories: ["deck"] }));
    const results = index.search({ limit: 2 }, { onboardingPicks: ["deck"] });
    expect(results[0]!.meta.id).toBe("b"); // matches onboarding pick
  });

  it("lineage depth — originals rank higher than deep forks (tie-breaker)", () => {
    index.upsert(makeEntry("original", { remixCount: 5, lineageDepth: 0 }));
    index.upsert(makeEntry("fork", { remixCount: 5, lineageDepth: 2 }));
    const results = index.search({ limit: 2 });
    expect(results[0]!.meta.id).toBe("original");
  });

  it("install count is tertiary signal (after remix + personalization)", () => {
    index.upsert(makeEntry("a", { remixCount: 5, installCount: 100 }));
    index.upsert(makeEntry("b", { remixCount: 5, installCount: 10 }));
    const results = index.search({ limit: 2 });
    expect(results[0]!.meta.id).toBe("a"); // more installs
  });

  it("text filter matches name", () => {
    index.upsert(makeEntry("deck-minimal", { categories: ["deck"] }));
    index.upsert(makeEntry("poster-bold", { categories: ["poster"] }));
    const results = index.search({ text: "deck" });
    expect(results).toHaveLength(1);
    expect(results[0]!.meta.id).toBe("deck-minimal");
  });

  it("text filter matches description", () => {
    const e = makeEntry("e1");
    e.meta.description = { en: "a poster for events" };
    index.upsert(e);
    const results = index.search({ text: "poster" });
    expect(results).toHaveLength(1);
  });

  it("category filter", () => {
    index.upsert(makeEntry("a", { categories: ["deck"] }));
    index.upsert(makeEntry("b", { categories: ["poster"] }));
    const results = index.search({ categories: ["poster"] });
    expect(results).toHaveLength(1);
    expect(results[0]!.meta.id).toBe("b");
  });

  it("maxLineageDepth filters deep forks", () => {
    index.upsert(makeEntry("orig", { lineageDepth: 0 }));
    index.upsert(makeEntry("fork1", { lineageDepth: 1 }));
    index.upsert(makeEntry("fork2", { lineageDepth: 2 }));
    const results = index.search({ maxLineageDepth: 1 });
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.meta.id).sort()).toEqual(["fork1", "orig"]);
  });

  it("limit is respected", () => {
    for (let i = 0; i < 30; i++) {
      index.upsert(makeEntry(`t${i}`, { remixCount: i }));
    }
    const results = index.search({ limit: 5 });
    expect(results).toHaveLength(5);
  });
});

describe("incrementRemixCount / incrementInstallCount", () => {
  it("remix count increments", () => {
    const index = new TemplateSearchIndex();
    index.upsert(makeEntry("a", { remixCount: 5 }));
    index.incrementRemixCount("a");
    const results = index.search({});
    expect(results[0]!.remixCount).toBe(6);
  });

  it("install count increments", () => {
    const index = new TemplateSearchIndex();
    index.upsert(makeEntry("a", { installCount: 10 }));
    index.incrementInstallCount("a");
    const results = index.search({});
    expect(results[0]!.installCount).toBe(11);
  });

  it("remove deletes an entry", () => {
    const index = new TemplateSearchIndex();
    index.upsert(makeEntry("a"));
    index.remove("a");
    expect(index.search({})).toHaveLength(0);
  });
});

describe("computePersonalizationMatch", () => {
  const features: UserStyleFeatures = {
    dominantColorFamilies: ["blue", "neutral"],
    preferredSpaceScale: 4,
    preferredRadiusStyle: "sharp",
  };

  it("scores 0 when no overlap", () => {
    const entry = makeEntry("a", { tokenValues: { "brand.primary": "#ff0000" } });
    const score = computePersonalizationMatch(entry, features);
    expect(score).toBeLessThan(50); // no color family match
  });

  it("scores higher when color family matches", () => {
    const entry = makeEntry("a", { tokenValues: { "brand.primary": "#1a1aff" } }); // blue
    const score = computePersonalizationMatch(entry, features);
    expect(score).toBeGreaterThanOrEqual(50); // blue family match
  });

  it("scores higher when space scale matches", () => {
    const entry = makeEntry("a", {
      tokenValues: { "brand.primary": "#1a1aff", "space.1": "4" },
    });
    const score = computePersonalizationMatch(entry, features);
    expect(score).toBeGreaterThanOrEqual(75); // color + space match
  });

  it("scores higher when radius style matches", () => {
    const entry = makeEntry("a", {
      tokenValues: { "brand.primary": "#1a1aff", "space.1": "4", "radius.1": "1" }, // sharp
    });
    const score = computePersonalizationMatch(entry, features);
    expect(score).toBe(100); // all match
  });
});

describe("lineage", () => {
  it("computeLineageDepth walks derivedFrom chain", () => {
    const lineage = [
      { templateId: "a", derivedFrom: null },
      { templateId: "b", derivedFrom: "a" },
      { templateId: "c", derivedFrom: "b" },
    ];
    expect(computeLineageDepth("a", lineage)).toBe(0);
    expect(computeLineageDepth("b", lineage)).toBe(1);
    expect(computeLineageDepth("c", lineage)).toBe(2);
  });

  it("computeLineageDepth handles cycles (guard at 100)", () => {
    const lineage = [
      { templateId: "a", derivedFrom: "b" },
      { templateId: "b", derivedFrom: "a" },
    ];
    const depth = computeLineageDepth("a", lineage);
    expect(depth).toBe(100); // cycle guard
  });

  it("computeDerivatives lists direct forks", () => {
    const lineage = [
      { templateId: "a", derivedFrom: null },
      { templateId: "b", derivedFrom: "a" },
      { templateId: "c", derivedFrom: "a" },
      { templateId: "d", derivedFrom: "b" },
    ];
    const derivs = computeDerivatives("a", lineage);
    expect(derivs.sort()).toEqual(["b", "c"]);
  });
});
