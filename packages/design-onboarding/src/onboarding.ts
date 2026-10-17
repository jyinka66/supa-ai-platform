/**
 * @supa/design-onboarding/onboarding
 * ----------------------------------------------------------------
 * The 60-second path, built entirely from existing machinery.
 *
 *   1. Seed intent (3 picks max): what are you making (deck/poster/
 *      social/doc), style direction (3 visual archetypes = token
 *      tables, shown as live-rendered swatches — the render engine
 *      previews them, no stock imagery), brand inputs optional
 *      (logo upload → asset pipeline, brand colors → token table
 *      seeded, font preference → fonts package).
 *
 *   2. First doc = template install + token substitution. The user's
 *      brand tokens replace the template's brand.* namespace at
 *      materialize time — the doc they land in is ALREADY theirs:
 *      their colors, their logo, their fonts. Not a demo, a starting
 *      point. This is the whole onboarding thesis: skip the empty
 *      canvas AND skip the generic template, land in the middle.
 *
 *   3. First-edit coach: contextual, not tour-based — first text
 *      selection shows inline editing affordance, first AI use shows
 *      the constrained prompt box with a real suggestion, first
 *      share shows the link flow. Coach marks are ops-recorded so
 *      they resume across devices and never repeat (telemetry:
 *      coach dismissal = implicit signal for the ai-quality channel
 *      of onboarding itself).
 *
 *   4. Empty-canvas users (the ones who refuse templates) get the
 *      blank doc but the canvas still carries their token table in
 *      the inspector — extract-to-token and AI palette land in
 *      fertile soil later.
 * ----------------------------------------------------------------
 */

import type { TemplateCategory } from "@supa/design-marketplace/template-package";

// ───────────────────────────────────────────────
// Step 1 — Seed intent (3 picks max)
// ───────────────────────────────────────────────

export type DocType = "deck" | "poster" | "social" | "doc";
export type StyleArchetype = "minimal" | "editorial" | "playful" | "corporate";

/** 3 visual archetypes = token tables, shown as live-rendered swatches. */
export interface StyleArchetypePreview {
  archetype: StyleArchetype;
  /** Token table (rendered live, not stock imagery). */
  tokenTable: Record<string, string>;
  /** Rendered preview (SVG string, content-addressed). */
  previewSvg: string;
}

export interface BrandInputs {
  /** Logo upload → asset pipeline. Optional. */
  logoAssetHash?: string | undefined;
  /** Brand colors → token table seeded. Optional. */
  brandColors?: string[] | undefined;
  /** Font preference → fonts package. Optional. */
  preferredFontFamily?: string | undefined;
}

/**
 * Seed intent: 3 picks max.
 *   - Pick 1: what are you making (doc type)
 *   - Pick 2: style direction (visual archetype)
 *   - Pick 3 (optional): brand inputs
 */
export interface SeedIntent {
  docType: DocType;
  archetype: StyleArchetype;
  brandInputs?: BrandInputs | undefined;
}

export interface OnboardingSeedStep {
  /** The 3 archetype previews shown to the user. */
  previews: StyleArchetypePreview[];
  /** Limit: 3 picks max. */
  maxPicks: 3;
}

export function buildSeedStep(archetypes: StyleArchetypePreview[]): OnboardingSeedStep {
  return {
    previews: archetypes.slice(0, 3),
    maxPicks: 3,
  };
}

// ───────────────────────────────────────────────
// Step 2 — First doc = template install + token substitution
// ───────────────────────────────────────────────

/**
 * The user's brand tokens replace the template's brand.* namespace
 * at materialize time. The doc they land in is ALREADY theirs:
 * their colors, their logo, their fonts. Not a demo, a starting
 * point.
 *
 * This is the whole onboarding thesis: skip the empty canvas AND
 * skip the generic template, land in the middle.
 */
export interface TokenSubstitution {
  /** Namespace to replace (typically "brand"). */
  namespace: string;
  /** Replacement token values. */
  tokens: { id: string; value: string }[];
}

export interface MaterializeResult {
  /** New doc id (the forked, substituted instance). */
  docId: string;
  /** Token table with substitutions applied. */
  tokens: unknown;
  /** Template id the doc was forked from. */
  templateId: string;
  /** True if brand colors were substituted into brand.* namespace. */
  brandSubstituted: boolean;
  /** True if logo asset was placed in the doc. */
  logoPlaced: boolean;
}

export interface MaterializeOptions {
  /** Token substitution applier — calls into design-tokens/bindings. */
  applySubstitution: (sub: TokenSubstitution, doc: unknown) => Promise<unknown>;
  /** Doc id generator. */
  generateDocId: () => string;
}

/**
 * Materialize the first doc from a template + user's seed intent.
 * Substitutes brand tokens before the user sees the doc.
 */
export async function materializeFirstDoc(
  templateId: string,
  templateDoc: unknown,
  templateTokens: unknown,
  intent: SeedIntent,
  opts: MaterializeOptions,
): Promise<MaterializeResult> {
  const substitutions: TokenSubstitution[] = [];

  // Brand colors → brand.* namespace.
  if (intent.brandInputs?.brandColors && intent.brandInputs.brandColors.length > 0) {
    substitutions.push({
      namespace: "brand",
      tokens: intent.brandInputs.brandColors.map((color, i) => ({
        id: `brand.color.${i}`,
        value: color,
      })),
    });
  }

  // Apply substitutions (the host wires this to design-tokens).
  let doc = templateDoc;
  for (const sub of substitutions) {
    doc = await opts.applySubstitution(sub, doc);
  }

  return {
    docId: opts.generateDocId(),
    tokens: templateTokens, // substitution already applied to doc
    templateId,
    brandSubstituted: substitutions.some((s) => s.namespace === "brand"),
    logoPlaced: !!intent.brandInputs?.logoAssetHash,
  };
}

// ───────────────────────────────────────────────
// Step 3 — First-edit coach (contextual, not tour-based)
// ───────────────────────────────────────────────

export type CoachTrigger =
  | "first-text-selection" // inline editing affordance
  | "first-ai-use" // constrained prompt box with real suggestion
  | "first-share" // link flow
  | "first-extract-to-token" // when literal detected, suggest extraction
  | "first-template-update"; // when an installed template has an update

export interface CoachMark {
  /** Trigger that fired this coach mark. */
  trigger: CoachTrigger;
  /** Stable id (so we can record "shown" state across devices). */
  markId: string;
  /** The doc context (for resuming across sessions). */
  docId: string;
  /** When the coach mark was shown (ms epoch). */
  shownAt: number;
  /** Whether the user dismissed it (implicit signal). */
  dismissed: boolean;
}

/**
 * Coach marks are ops-recorded so they resume across devices and
 * never repeat. The state is a simple list of shown mark ids.
 */
export interface CoachMarkState {
  /** Mark ids that have been shown (never repeat). */
  shown: string[];
  /** Mark ids that were dismissed (implicit signal). */
  dismissed: string[];
}

export class CoachMarkTracker {
  private readonly state: CoachMarkState = { shown: [], dismissed: [] };

  /** Returns true if the coach mark should be shown (not yet shown). */
  shouldShow(trigger: CoachTrigger, docId: string): boolean {
    const markId = makeMarkId(trigger, docId);
    return !this.state.shown.includes(markId);
  }

  /** Record that a coach mark was shown. */
  recordShown(trigger: CoachTrigger, docId: string, shownAt: number = Date.now()): CoachMark {
    const markId = makeMarkId(trigger, docId);
    this.state.shown.push(markId);
    return { trigger, markId, docId, shownAt, dismissed: false };
  }

  /** Record dismissal (implicit signal — feeds ai-quality channel). */
  recordDismissal(trigger: CoachTrigger, docId: string): void {
    const markId = makeMarkId(trigger, docId);
    this.state.dismissed.push(markId);
  }

  /** Serialize state for cross-device resume (ops-recorded). */
  serialize(): CoachMarkState {
    return { shown: [...this.state.shown], dismissed: [...this.state.dismissed] };
  }

  /** Restore state from a serialized snapshot. */
  restore(state: CoachMarkState): void {
    this.state.shown = [...state.shown];
    this.state.dismissed = [...state.dismissed];
  }
}

function makeMarkId(trigger: CoachTrigger, docId: string): string {
  return `${trigger}:${docId}`;
}

// ───────────────────────────────────────────────
// Step 4 — Empty-canvas users
// ───────────────────────────────────────────────

/**
 * Empty-canvas users (the ones who refuse templates) get the blank
 * doc but the canvas still carries their token table in the inspector
 * — extract-to-token and AI palette land in fertile soil later.
 *
 * This function produces the seed token table for an empty-canvas
 * doc, using the user's brand inputs (if any) or the picked archetype's
 * defaults.
 */
export function buildEmptyCanvasTokens(intent: SeedIntent): { id: string; value: string }[] {
  // Archetype defaults — these are the platform's baseline for each
  // archetype. The user's brand inputs override on top.
  const archetypeDefaults: Record<StyleArchetype, { id: string; value: string }[]> = {
    minimal: [
      { id: "brand.primary", value: "#1a1a1a" },
      { id: "surface.1", value: "#ffffff" },
      { id: "space.1", value: "4" },
    ],
    editorial: [
      { id: "brand.primary", value: "#8b0000" },
      { id: "surface.1", value: "#fafafa" },
      { id: "space.1", value: "8" },
    ],
    playful: [
      { id: "brand.primary", value: "#ff6b6b" },
      { id: "surface.1", value: "#fff8e7" },
      { id: "space.1", value: "12" },
    ],
    corporate: [
      { id: "brand.primary", value: "#1a1aff" },
      { id: "surface.1", value: "#f5f5f5" },
      { id: "space.1", value: "6" },
    ],
  };

  const tokens = [...archetypeDefaults[intent.archetype]];

  // Override with brand colors if provided.
  if (intent.brandInputs?.brandColors) {
    const colors = intent.brandInputs.brandColors;
    for (let i = 0; i < Math.min(colors.length, 3); i++) {
      const existing = tokens.findIndex((t) => t.id === `brand.color.${i}`);
      if (existing >= 0) {
        tokens[existing] = { id: `brand.color.${i}`, value: colors[i]! };
      } else {
        tokens.push({ id: `brand.color.${i}`, value: colors[i]! });
      }
    }
  }

  return tokens;
}

// ───────────────────────────────────────────────
// Onboarding path selection (template vs empty canvas)
// ───────────────────────────────────────────────

export type OnboardingPath = "template" | "empty-canvas";

export interface PathDecision {
  path: OnboardingPath;
  /** Template id if path=template; undefined if empty-canvas. */
  templateId?: string;
}

/**
 * The user picks a template from the discovery results, OR refuses
 * and gets the empty canvas. Either way, their token table goes
 * with them.
 */
export function decidePath(
  intent: SeedIntent,
  pickedTemplateId?: string,
): PathDecision {
  if (pickedTemplateId) {
    return { path: "template", templateId: pickedTemplateId };
  }
  // Empty-canvas users still get the archetype + brand tokens.
  return { path: "empty-canvas" };
}

// ───────────────────────────────────────────────
// Helpers — category mapping
// ───────────────────────────────────────────────

export function docTypeToCategory(docType: DocType): TemplateCategory {
  switch (docType) {
    case "deck":
      return "deck";
    case "poster":
      return "poster";
    case "social":
      return "social";
    case "doc":
      return "doc";
  }
}
