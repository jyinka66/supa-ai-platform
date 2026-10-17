/**
 * Template install tests.
 *
 * Covers:
 *   - install = fork + validate
 *   - validation passes on a valid package → doc + tokens forked
 *   - validation fails on a malformed package → no materialization,
 *     missing fonts listed honestly
 *   - every install is a fork (no shared mutable state)
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  installTemplate,
  type TemplatePackage,
  type InstallValidator,
  type FontManifest,
  type FontRequirement,
} from "../src/template-package.js";

// ───────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────

function makePackage(overrides?: Partial<TemplatePackage>): TemplatePackage {
  return {
    meta: {
      id: "tmpl-1",
      semver: "1.0.0",
      author: "author-1",
      license: "MIT",
      categories: ["deck"],
      preview: { thumbnails: ["hash-1"], animatedPreview: "anim-1" },
      name: { en: "Template 1" },
      description: { en: "A template" },
      aiAssisted: false,
    },
    doc: { pages: [{ id: "p1", layers: [] }] },
    tokens: { mapId: "stub", tokens: new Map() },
    fonts: { requirements: [] },
    compat: { minAppVersion: "0.1.0", opSchemaVersion: 1 },
    packageHash: "abc123",
    ...overrides,
  };
}

function makeValidator(opts?: { docOk?: boolean; tokensOk?: boolean }): InstallValidator {
  return {
    validateDoc: () => ({
      ok: opts?.docOk ?? true,
      violations: opts?.docOk === false ? [{ layerId: "doc-root", kind: "schema", message: "bad doc" }] : [],
    }),
    validateTokens: () => ({
      ok: opts?.tokensOk ?? true,
      errors: opts?.tokensOk === false ? [{ tokenId: "root", message: "bad tokens" }] : [],
    }),
  };
}

const noMissingFonts = async () => ({ missing: [] as FontRequirement[] });
const someMissingFonts = async (m: FontManifest) => ({
  missing: m.requirements.slice(0, 1),
});

let counter = 0;
const generateDocId = () => `doc-${++counter}`;

// ───────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────

describe("installTemplate", () => {
  beforeEach(() => {
    counter = 0;
  });

  it("forks the doc + tokens when validation passes", async () => {
    const pkg = makePackage();
    const result = await installTemplate(pkg, {
      validator: makeValidator(),
      generateDocId,
      resolveFonts: noMissingFonts,
    });

    expect(result.docId).toBe("doc-1");
    expect(result.doc).toBe(pkg.doc); // forked (same ref in stub)
    expect(result.tokens).toBe(pkg.tokens);
    expect(result.missingFonts).toEqual([]);
    expect(result.validation.ok).toBe(true);
  });

  it("lists missing fonts honestly at install", async () => {
    const pkg = makePackage({
      fonts: {
        requirements: [
          { family: "missing-font", subsets: [], axes: [] },
          { family: "present-font", subsets: [], axes: [] },
        ],
      },
    });
    const result = await installTemplate(pkg, {
      validator: makeValidator(),
      generateDocId,
      resolveFonts: someMissingFonts,
    });

    expect(result.missingFonts).toHaveLength(1);
    expect(result.missingFonts[0]!.family).toBe("missing-font");
  });

  it("refuses to materialize when doc validation fails", async () => {
    const pkg = makePackage();
    const result = await installTemplate(pkg, {
      validator: makeValidator({ docOk: false }),
      generateDocId,
      resolveFonts: noMissingFonts,
    });

    expect(result.validation.ok).toBe(false);
    expect(result.validation.invariantViolations).toHaveLength(1);
    expect(result.validation.invariantViolations[0]!.kind).toBe("schema");
  });

  it("refuses to materialize when token validation fails", async () => {
    const pkg = makePackage();
    const result = await installTemplate(pkg, {
      validator: makeValidator({ tokensOk: false }),
      generateDocId,
      resolveFonts: noMissingFonts,
    });

    expect(result.validation.ok).toBe(false);
    expect(result.validation.tokenErrors).toHaveLength(1);
  });

  it("every install is a fork (each gets a new doc id)", async () => {
    const pkg = makePackage();
    const r1 = await installTemplate(pkg, {
      validator: makeValidator(),
      generateDocId,
      resolveFonts: noMissingFonts,
    });
    const r2 = await installTemplate(pkg, {
      validator: makeValidator(),
      generateDocId,
      resolveFonts: noMissingFonts,
    });

    expect(r1.docId).not.toBe(r2.docId);
  });
});

describe("computeUpdateDiff", () => {
  it("flags breaking change on MAJOR bump", async () => {
    const { computeUpdateDiff } = await import("../src/template-package.js");
    const old = makePackage({ meta: { ...makePackage().meta, semver: "1.0.0" } });
    const next = makePackage({ meta: { ...makePackage().meta, semver: "2.0.0" } });
    const diff = computeUpdateDiff(old, next);
    expect(diff.breaking).toBe(true);
    expect(diff.autoApplicable).toBe(false);
  });

  it("non-breaking MINOR bump is auto-applicable", async () => {
    const { computeUpdateDiff } = await import("../src/template-package.js");
    const old = makePackage({ meta: { ...makePackage().meta, semver: "1.0.0" } });
    const next = makePackage({ meta: { ...makePackage().meta, semver: "1.1.0" } });
    const diff = computeUpdateDiff(old, next);
    expect(diff.breaking).toBe(false);
    expect(diff.autoApplicable).toBe(true); // no token removals in stub
  });

  it("PATCH bump is non-breaking", async () => {
    const { computeUpdateDiff } = await import("../src/template-package.js");
    const old = makePackage({ meta: { ...makePackage().meta, semver: "1.0.0" } });
    const next = makePackage({ meta: { ...makePackage().meta, semver: "1.0.1" } });
    const diff = computeUpdateDiff(old, next);
    expect(diff.breaking).toBe(false);
  });

  it("detects added tokens (MINOR, still auto-applicable)", async () => {
    const { computeUpdateDiff } = await import("../src/template-package.js");
    const old = makePackage({
      tokens: new Map([["brand.primary", { value: "#ff0000" }]]),
    });
    const next = makePackage({
      tokens: new Map([
        ["brand.primary", { value: "#ff0000" }],
        ["brand.secondary", { value: "#00ff00" }], // added
      ]),
    });
    const diff = computeUpdateDiff(old, next);
    expect(diff.tokenChanges.added).toEqual(["brand.secondary"]);
    expect(diff.tokenChanges.removed).toEqual([]);
    expect(diff.tokenChanges.changed).toEqual([]);
    expect(diff.autoApplicable).toBe(true); // additive
  });

  it("detects removed tokens (MAJOR concern, NOT auto-applicable)", async () => {
    const { computeUpdateDiff } = await import("../src/template-package.js");
    const old = makePackage({
      tokens: new Map([
        ["brand.primary", { value: "#ff0000" }],
        ["brand.deprecated", { value: "#888888" }], // will be removed
      ]),
    });
    const next = makePackage({
      tokens: new Map([["brand.primary", { value: "#ff0000" }]]),
    });
    const diff = computeUpdateDiff(old, next);
    expect(diff.tokenChanges.removed).toEqual(["brand.deprecated"]);
    expect(diff.tokenChanges.added).toEqual([]);
    expect(diff.tokenChanges.changed).toEqual([]);
    expect(diff.autoApplicable).toBe(false); // removed token = can't auto-apply
  });

  it("detects changed tokens (re-theme — MAJOR concern)", async () => {
    const { computeUpdateDiff } = await import("../src/template-package.js");
    const old = makePackage({
      tokens: new Map([["brand.primary", { value: "#ff0000" }]]),
    });
    const next = makePackage({
      tokens: new Map([["brand.primary", { value: "#00ff00" }]]), // re-themed
    });
    const diff = computeUpdateDiff(old, next);
    expect(diff.tokenChanges.changed).toEqual(["brand.primary"]);
    expect(diff.tokenChanges.added).toEqual([]);
    expect(diff.tokenChanges.removed).toEqual([]);
  });

  it("handles Record-backed token tables (not just Map)", async () => {
    const { computeUpdateDiff } = await import("../src/template-package.js");
    const old = makePackage({
      tokens: { "brand.primary": { value: "#ff0000" } },
    });
    const next = makePackage({
      tokens: {
        "brand.primary": { value: "#ff0000" },
        "brand.accent": { value: "#0000ff" }, // added
      },
    });
    const diff = computeUpdateDiff(old, next);
    expect(diff.tokenChanges.added).toEqual(["brand.accent"]);
  });

  it("handles wrapped token tables `{ tokens: Map | Record }`", async () => {
    const { computeUpdateDiff } = await import("../src/template-package.js");
    const old = makePackage({
      tokens: { mapId: "old", tokens: { "brand.primary": { value: "#ff0000" } } },
    });
    const next = makePackage({
      tokens: { mapId: "new", tokens: { "brand.primary": { value: "#00ff00" } } },
    });
    const diff = computeUpdateDiff(old, next);
    expect(diff.tokenChanges.changed).toEqual(["brand.primary"]);
  });

  it("no token changes → tokenChanges is empty (not stub-shaped)", async () => {
    const { computeUpdateDiff } = await import("../src/template-package.js");
    const old = makePackage({
      tokens: new Map([["brand.primary", { value: "#ff0000" }]]),
    });
    const next = makePackage({
      tokens: new Map([["brand.primary", { value: "#ff0000" }]]),
    });
    const diff = computeUpdateDiff(old, next);
    expect(diff.tokenChanges.added).toEqual([]);
    expect(diff.tokenChanges.removed).toEqual([]);
    expect(diff.tokenChanges.changed).toEqual([]);
  });
});
