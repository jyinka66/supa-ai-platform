/**
 * Publish gauntlet tests.
 *
 * Covers:
 *   - all gates pass → ok=true
 *   - tokens gate fails (literals in published template)
 *   - a11y gate fails (contrast below threshold)
 *   - perf gate fails (over node budget)
 *   - fonts gate fails (unknown license)
 *   - compat gate fails (op-schema version too high)
 *   - provenance gate fails (AI tokens but aiAssisted=false)
 *   - sampling-based human review fires when sampling rate met
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  runPublishGauntlet,
  computeSemverBump,
  bumpSemver,
  type GateFailure,
  type TokensGate,
  type A11yGate,
  type PerfGate,
  type FontsGate,
  type CompatGate,
  type ProvenanceGate,
} from "../src/publish.js";
import type { TemplatePackage } from "../src/template-package.js";

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
      preview: { thumbnails: [], animatedPreview: "" },
      name: { en: "T" },
      description: { en: "D" },
      aiAssisted: false,
    },
    doc: {},
    tokens: {},
    fonts: { requirements: [] },
    compat: { minAppVersion: "0.1.0", opSchemaVersion: 1 },
    packageHash: "abc",
    ...overrides,
  };
}

function passGate(): GateFailure | null {
  return null;
}

function failGate(gate: GateFailure["gate"], message: string): GateFailure {
  return { gate, message, details: [] };
}

function makeOpts(overrides?: Partial<{
  tokens: TokensGate;
  a11y: A11yGate;
  perf: PerfGate;
  fonts: FontsGate;
  compat: CompatGate;
  provenance: ProvenanceGate;
  reviewSamplingRate: number;
  random: () => number;
}>): Parameters<typeof runPublishGauntlet>[1] {
  return {
    tokensGate: overrides?.tokens ?? { check: passGate },
    a11yGate: overrides?.a11y ?? { check: passGate },
    perfGate: overrides?.perf ?? { check: passGate },
    fontsGate: overrides?.fonts ?? { check: passGate },
    compatGate: overrides?.compat ?? { check: passGate },
    provenanceGate: overrides?.provenance ?? { check: passGate },
    reviewSamplingRate: overrides?.reviewSamplingRate ?? 0.05,
    random: overrides?.random ?? (() => 0.5),
  };
}

// ───────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────

describe("runPublishGauntlet", () => {
  it("passes when all gates pass", () => {
    const result = runPublishGauntlet(makePackage(), makeOpts());
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("fails when tokens gate fails (literals in template)", () => {
    const result = runPublishGauntlet(
      makePackage(),
      makeOpts({
        tokens: { check: () => failGate("tokens", "literals found") },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.failures[0]!.gate).toBe("tokens");
  });

  it("fails when a11y gate fails (contrast below threshold)", () => {
    const result = runPublishGauntlet(
      makePackage(),
      makeOpts({
        a11y: { check: () => failGate("a11y", "contrast 2.1:1") },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.failures[0]!.gate).toBe("a11y");
  });

  it("fails when perf gate fails (over node budget)", () => {
    const result = runPublishGauntlet(
      makePackage(),
      makeOpts({
        perf: { check: () => failGate("perf", "1200 nodes; budget 800") },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.failures[0]!.gate).toBe("perf");
  });

  it("fails when fonts gate fails (unknown license)", () => {
    const result = runPublishGauntlet(
      makePackage(),
      makeOpts({
        fonts: { check: () => failGate("fonts", "axis unknown license") },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.failures[0]!.gate).toBe("fonts");
  });

  it("fails when compat gate fails (op-schema version too high)", () => {
    const result = runPublishGauntlet(
      makePackage(),
      makeOpts({
        compat: { check: () => failGate("compat", "requires v5, current v1") },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.failures[0]!.gate).toBe("compat");
  });

  it("fails when provenance gate fails (AI tokens undeclared)", () => {
    const result = runPublishGauntlet(
      makePackage(),
      makeOpts({
        provenance: { check: () => failGate("provenance", "aiAssisted false but ai tokens present") },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.failures[0]!.gate).toBe("provenance");
  });

  it("multiple gates fail → all failures reported", () => {
    const result = runPublishGauntlet(
      makePackage(),
      makeOpts({
        tokens: { check: () => failGate("tokens", "literals") },
        a11y: { check: () => failGate("a11y", "contrast") },
        perf: { check: () => failGate("perf", "nodes") },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(3);
    expect(result.failures.map((f) => f.gate).sort()).toEqual(["a11y", "perf", "tokens"]);
  });

  it("needsHumanReview fires when sampling rate met (random < rate)", () => {
    const result = runPublishGauntlet(
      makePackage(),
      makeOpts({
        reviewSamplingRate: 0.10,
        random: () => 0.05, // < 0.10 → review
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.needsHumanReview).toBe(true);
  });

  it("needsHumanReview does not fire when random ≥ rate", () => {
    const result = runPublishGauntlet(
      makePackage(),
      makeOpts({
        reviewSamplingRate: 0.05,
        random: () => 0.50, // ≥ 0.05 → no review
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.needsHumanReview).toBe(false);
  });

  it("needsHumanReview does not fire when gates fail (review is for passing templates)", () => {
    const result = runPublishGauntlet(
      makePackage(),
      makeOpts({
        tokens: { check: () => failGate("tokens", "literals") },
        reviewSamplingRate: 1.0, // would always sample
        random: () => 0.0,
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.needsHumanReview).toBe(false);
  });
});

describe("RefProvenanceGate — token provenance inspection", () => {
  // Import the reference impl directly.
  let RefProvenanceGate: typeof import("../src/publish.js").RefProvenanceGate;
  beforeAll(async () => {
    ({ RefProvenanceGate } = await import("../src/publish.js"));
  });

  it("passes when meta.aiAssisted is true (declared honestly)", () => {
    const gate = new RefProvenanceGate();
    const pkg = makePackage({
      meta: { ...makePackage().meta, aiAssisted: true },
      tokens: {
        "brand.primary": { value: "#ff0000", provenance: { aiAssisted: true } },
      },
    });
    expect(gate.check(pkg)).toBeNull();
  });

  it("passes when meta.aiAssisted is false and no tokens have AI provenance", () => {
    const gate = new RefProvenanceGate();
    const pkg = makePackage({
      meta: { ...makePackage().meta, aiAssisted: false },
      tokens: {
        "brand.primary": { value: "#ff0000" },
        "brand.secondary": { value: "#00ff00" },
      },
    });
    expect(gate.check(pkg)).toBeNull();
  });

  it("fails when meta.aiAssisted is false but a token carries AI provenance", () => {
    const gate = new RefProvenanceGate();
    const pkg = makePackage({
      meta: { ...makePackage().meta, aiAssisted: false },
      tokens: {
        "brand.primary": { value: "#ff0000", provenance: { aiAssisted: true } },
      },
    });
    const result = gate.check(pkg);
    expect(result).not.toBeNull();
    expect(result!.gate).toBe("provenance");
    expect(result!.details.length).toBe(1);
    expect(result!.details[0]!.id).toBe("brand.primary");
  });

  it("also detects `provenance.source: 'ai'` markers", () => {
    const gate = new RefProvenanceGate();
    const pkg = makePackage({
      meta: { ...makePackage().meta, aiAssisted: false },
      tokens: new Map([
        ["brand.accent", { value: "#0000ff", provenance: { source: "ai" } }],
      ]),
    });
    const result = gate.check(pkg);
    expect(result).not.toBeNull();
    expect(result!.details[0]!.id).toBe("brand.accent");
  });

  it("handles Map-backed token tables (real token-table shape)", () => {
    const gate = new RefProvenanceGate();
    const pkg = makePackage({
      meta: { ...makePackage().meta, aiAssisted: false },
      tokens: new Map([
        ["brand.safe", { value: "#000000" }],
        ["brand.ai", { value: "#ffffff", provenance: { aiAssisted: true } }],
      ]),
    });
    const result = gate.check(pkg);
    expect(result).not.toBeNull();
    expect(result!.details.length).toBe(1);
    expect(result!.details[0]!.id).toBe("brand.ai");
  });

  it("no longer has the tautological dead branch `if (x && !x)`", () => {
    // Read the source — the tautological check should be gone.
    // (Documentation-as-test: this is the regression guard for the
    // audit finding.)
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "../src/publish.ts"),
      "utf8",
    );
    expect(src).not.toContain("aiAssisted && !pkg.meta.aiAssisted");
  });
});

describe("semver discipline", () => {
  it("MAJOR bump on token removed", () => {
    const bump = computeSemverBump(
      makePackage(),
      makePackage(),
      { tokenChanges: { added: [], removed: ["brand.primary"], changed: [] }, docChanges: [] },
    );
    expect(bump).toBe("MAJOR");
  });

  it("MAJOR bump on token changed (repurposed)", () => {
    const bump = computeSemverBump(
      makePackage(),
      makePackage(),
      { tokenChanges: { added: [], removed: [], changed: ["brand.primary"] }, docChanges: [] },
    );
    expect(bump).toBe("MAJOR");
  });

  it("MINOR bump on token added", () => {
    const bump = computeSemverBump(
      makePackage(),
      makePackage(),
      { tokenChanges: { added: ["brand.secondary"], removed: [], changed: [] }, docChanges: [] },
    );
    expect(bump).toBe("MINOR");
  });

  it("MINOR bump on doc change", () => {
    const bump = computeSemverBump(
      makePackage(),
      makePackage(),
      { tokenChanges: { added: [], removed: [], changed: [] }, docChanges: [{ op: "InsertLayer" }] },
    );
    expect(bump).toBe("MINOR");
  });

  it("PATCH bump on meta-only change", () => {
    const bump = computeSemverBump(
      makePackage(),
      makePackage(),
      { tokenChanges: { added: [], removed: [], changed: [] }, docChanges: [] },
    );
    expect(bump).toBe("PATCH");
  });

  it("bumpSemver applies MAJOR correctly", () => {
    expect(bumpSemver("1.2.3", "MAJOR")).toBe("2.0.0");
  });

  it("bumpSemver applies MINOR correctly", () => {
    expect(bumpSemver("1.2.3", "MINOR")).toBe("1.3.0");
  });

  it("bumpSemver applies PATCH correctly", () => {
    expect(bumpSemver("1.2.3", "PATCH")).toBe("1.2.4");
  });

  it("bumpSemver throws on invalid semver", () => {
    expect(() => bumpSemver("1.2", "MAJOR")).toThrow(/invalid semver/);
  });
});
