/**
 * Onboarding flow tests.
 *
 * Covers:
 *   - seed step (3 archetype previews, maxPicks=3)
 *   - materializeFirstDoc substitutes brand tokens
 *   - empty-canvas users get the archetype token table
 *   - coach marks: shouldShow, recordShown, never repeat
 *   - coach mark serialize/restore for cross-device resume
 *   - decidePath (template vs empty-canvas)
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  buildSeedStep,
  materializeFirstDoc,
  buildEmptyCanvasTokens,
  decidePath,
  CoachMarkTracker,
  type StyleArchetypePreview,
  type SeedIntent,
  type TokenSubstitution,
} from "../src/onboarding.js";

// ───────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────

const ARCHETYPE_PREVIEWS: StyleArchetypePreview[] = [
  { archetype: "minimal", tokenTable: {}, previewSvg: "<svg/>" },
  { archetype: "editorial", tokenTable: {}, previewSvg: "<svg/>" },
  { archetype: "playful", tokenTable: {}, previewSvg: "<svg/>" },
  { archetype: "corporate", tokenTable: {}, previewSvg: "<svg/>" },
];

const INTENT: SeedIntent = {
  docType: "deck",
  archetype: "minimal",
  brandInputs: {
    brandColors: ["#ff0000", "#00ff00", "#0000ff"],
    logoAssetHash: "asset-hash-1",
    preferredFontFamily: "Inter",
  },
};

// ───────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────

describe("buildSeedStep", () => {
  it("returns 3 archetype previews max", () => {
    const step = buildSeedStep(ARCHETYPE_PREVIEWS);
    expect(step.previews).toHaveLength(3);
    expect(step.maxPicks).toBe(3);
  });

  it("preserves order of input archetypes", () => {
    const step = buildSeedStep(ARCHETYPE_PREVIEWS);
    expect(step.previews[0]!.archetype).toBe("minimal");
    expect(step.previews[1]!.archetype).toBe("editorial");
    expect(step.previews[2]!.archetype).toBe("playful");
  });
});

describe("materializeFirstDoc", () => {
  let applyCount: number;
  const applySubstitution = async (sub: TokenSubstitution, doc: unknown) => {
    applyCount++;
    void sub;
    return doc;
  };
  const generateDocId = () => "doc-1";

  beforeEach(() => {
    applyCount = 0;
  });

  it("forks the template doc + tokens", async () => {
    const result = await materializeFirstDoc(
      "tmpl-1",
      { pages: [] },
      { mapId: "stub" },
      INTENT,
      { applySubstitution, generateDocId },
    );
    expect(result.docId).toBe("doc-1");
    expect(result.templateId).toBe("tmpl-1");
  });

  it("substitutes brand tokens when brand colors provided", async () => {
    const result = await materializeFirstDoc(
      "tmpl-1",
      {},
      {},
      INTENT,
      { applySubstitution, generateDocId },
    );
    expect(result.brandSubstituted).toBe(true);
    expect(applyCount).toBe(1);
  });

  it("does not substitute when no brand colors", async () => {
    const intent: SeedIntent = {
      docType: "deck",
      archetype: "minimal",
      // no brandInputs
    };
    const result = await materializeFirstDoc(
      "tmpl-1",
      {},
      {},
      intent,
      { applySubstitution, generateDocId },
    );
    expect(result.brandSubstituted).toBe(false);
    expect(applyCount).toBe(0);
  });

  it("logo placement is detected", async () => {
    const result = await materializeFirstDoc(
      "tmpl-1",
      {},
      {},
      INTENT,
      { applySubstitution, generateDocId },
    );
    expect(result.logoPlaced).toBe(true);
  });
});

describe("buildEmptyCanvasTokens", () => {
  it("returns archetype defaults for minimal", () => {
    const tokens = buildEmptyCanvasTokens({ docType: "deck", archetype: "minimal" });
    expect(tokens.find((t) => t.id === "brand.primary")!.value).toBe("#1a1a1a");
    expect(tokens.find((t) => t.id === "surface.1")!.value).toBe("#ffffff");
  });

  it("returns archetype defaults for editorial", () => {
    const tokens = buildEmptyCanvasTokens({ docType: "poster", archetype: "editorial" });
    expect(tokens.find((t) => t.id === "brand.primary")!.value).toBe("#8b0000");
  });

  it("overrides with brand colors when provided", () => {
    const tokens = buildEmptyCanvasTokens({
      docType: "deck",
      archetype: "minimal",
      brandInputs: { brandColors: ["#abcdef", "#fedcba"] },
    });
    expect(tokens.find((t) => t.id === "brand.color.0")!.value).toBe("#abcdef");
    expect(tokens.find((t) => t.id === "brand.color.1")!.value).toBe("#fedcba");
  });

  it("preserves archetype defaults when no brand colors", () => {
    const tokens = buildEmptyCanvasTokens({ docType: "deck", archetype: "playful" });
    expect(tokens.find((t) => t.id === "brand.primary")!.value).toBe("#ff6b6b");
  });
});

describe("decidePath", () => {
  it("returns template path when templateId provided", () => {
    const decision = decidePath(INTENT, "tmpl-1");
    expect(decision.path).toBe("template");
    expect(decision.templateId).toBe("tmpl-1");
  });

  it("returns empty-canvas path when no templateId", () => {
    const decision = decidePath(INTENT);
    expect(decision.path).toBe("empty-canvas");
    expect(decision.templateId).toBeUndefined();
  });
});

describe("CoachMarkTracker", () => {
  let tracker: CoachMarkTracker;

  beforeEach(() => {
    tracker = new CoachMarkTracker();
  });

  it("shouldShow returns true for unseen marks", () => {
    expect(tracker.shouldShow("first-text-selection", "doc-1")).toBe(true);
  });

  it("shouldShow returns false after mark is shown", () => {
    tracker.recordShown("first-text-selection", "doc-1");
    expect(tracker.shouldShow("first-text-selection", "doc-1")).toBe(false);
  });

  it("shouldShow is per-doc (same trigger, different doc = different mark)", () => {
    tracker.recordShown("first-text-selection", "doc-1");
    expect(tracker.shouldShow("first-text-selection", "doc-2")).toBe(true);
  });

  it("shouldShow is per-trigger (same doc, different trigger = different mark)", () => {
    tracker.recordShown("first-text-selection", "doc-1");
    expect(tracker.shouldShow("first-ai-use", "doc-1")).toBe(true);
  });

  it("recordDismissal records the implicit signal", () => {
    tracker.recordShown("first-text-selection", "doc-1");
    tracker.recordDismissal("first-text-selection", "doc-1");
    const state = tracker.serialize();
    expect(state.dismissed).toHaveLength(1);
    expect(state.dismissed[0]).toContain("first-text-selection");
  });

  it("serialize + restore round-trips state", () => {
    tracker.recordShown("first-text-selection", "doc-1");
    tracker.recordShown("first-ai-use", "doc-1");
    tracker.recordDismissal("first-text-selection", "doc-1");

    const serialized = tracker.serialize();
    const newTracker = new CoachMarkTracker();
    newTracker.restore(serialized);

    // Marks already shown should not show again.
    expect(newTracker.shouldShow("first-text-selection", "doc-1")).toBe(false);
    expect(newTracker.shouldShow("first-ai-use", "doc-1")).toBe(false);
    // New doc still shows.
    expect(newTracker.shouldShow("first-text-selection", "doc-2")).toBe(true);
  });

  it("never repeats a shown mark (the contract)", () => {
    tracker.recordShown("first-share", "doc-1");
    // Same trigger + doc → never again.
    expect(tracker.shouldShow("first-share", "doc-1")).toBe(false);
    tracker.recordShown("first-share", "doc-1"); // no-op effectively
    expect(tracker.shouldShow("first-share", "doc-1")).toBe(false);
  });
});
