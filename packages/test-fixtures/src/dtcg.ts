/**
 * @supa/test-fixtures/dtcg
 * ----------------------------------------------------------------
 * W3C DTCG (Design Tokens Community Group) round-trip fixtures,
 * consolidated from @supa/design-tokens' codegen module. These
 * fixtures test the export → import round-trip: a token map
 * exported as DTCG JSON, then imported back, should produce the
 * same set of tokens (modulo provenance).
 *
 * The marketplace seam depends on this: a template's token table
 * exports as DTCG JSON → importable into Style Dictionary, Tailwind
 * config, or any consumer. The round-trip must be stable.
 * ----------------------------------------------------------------
 */

// ───────────────────────────────────────────────
// DTCG round-trip fixture
// ───────────────────────────────────────────────

export interface DtcgRoundTripFixture {
  /** Name of the fixture. */
  name: string;
  /** The DTCG JSON file (as a plain object, for testing). */
  dtcg: Record<string, unknown>;
  /** Expected token ids after import (sorted, for assertion). */
  expectedTokenIds: readonly string[];
  /** Expected types after import (id → type). */
  expectedTypes: Readonly<Record<string, string>>;
  /** Description of what the fixture tests. */
  description: string;
}

// ───────────────────────────────────────────────
// Fixtures
// ───────────────────────────────────────────────

export const DTCG_ROUND_TRIP_FIXTURES: readonly DtcgRoundTripFixture[] = Object.freeze([
  {
    name: "simple-color-tokens",
    description: "Simple color tokens (brand.primary, brand.secondary) in a single namespace.",
    dtcg: {
      $schema: "https://design-tokens.org/schema",
      brand: {
        primary: { $value: "#1a1aff", $type: "color" },
        secondary: { $value: "#ff6b6b", $type: "color" },
      },
    },
    expectedTokenIds: Object.freeze(["brand.primary", "brand.secondary"]),
    expectedTypes: Object.freeze({ "brand.primary": "color", "brand.secondary": "color" }),
  },
  {
    name: "space-scale",
    description: "Space scale (space.1 through space.4) as dimension tokens.",
    dtcg: {
      $schema: "https://design-tokens.org/schema",
      space: {
        1: { $value: 4, $type: "dimension" },
        2: { $value: 8, $type: "dimension" },
        3: { $value: 16, $type: "dimension" },
        4: { $value: 32, $type: "dimension" },
      },
    },
    expectedTokenIds: Object.freeze(["space.1", "space.2", "space.3", "space.4"]),
    expectedTypes: Object.freeze({
      "space.1": "space",
      "space.2": "space",
      "space.3": "space",
      "space.4": "space",
    }),
  },
  {
    name: "ref-chain",
    description: "Ref chain (surface.1 references brand.primary via $ prefix).",
    dtcg: {
      $schema: "https://design-tokens.org/schema",
      brand: {
        primary: { $value: "#1a1aff", $type: "color" },
      },
      surface: {
        1: { $value: "$brand.primary", $type: "color" },
      },
    },
    expectedTokenIds: Object.freeze(["brand.primary", "surface.1"]),
    expectedTypes: Object.freeze({ "brand.primary": "color", "surface.1": "color" }),
  },
  {
    name: "variant-tokens",
    description: "Variant-specific values (light/dark) as $value.<variant> entries.",
    dtcg: {
      $schema: "https://design-tokens.org/schema",
      brand: {
        primary: {
          $value: "#1a1aff",
          $type: "color",
          "$value.dark": "#6666ff",
        },
      },
    },
    expectedTokenIds: Object.freeze(["brand.primary"]),
    expectedTypes: Object.freeze({ "brand.primary": "color" }),
  },
  {
    name: "nested-namespaces",
    description: "Deeply nested namespaces (component.button.primary).",
    dtcg: {
      $schema: "https://design-tokens.org/schema",
      component: {
        button: {
          primary: { $value: "#0066cc", $type: "color" },
        },
      },
    },
    expectedTokenIds: Object.freeze(["component.button.primary"]),
    expectedTypes: Object.freeze({ "component.button.primary": "color" }),
  },
  {
    name: "mixed-types",
    description: "Mixed token types (color + dimension + duration) in one namespace.",
    dtcg: {
      $schema: "https://design-tokens.org/schema",
      brand: {
        color: { $value: "#1a1aff", $type: "color" },
        space: { $value: 16, $type: "dimension" },
        duration: { $value: 200, $type: "duration" },
      },
    },
    expectedTokenIds: Object.freeze(["brand.color", "brand.duration", "brand.space"]),
    expectedTypes: Object.freeze({
      "brand.color": "color",
      "brand.space": "space",
      "brand.duration": "duration",
    }),
  },
  {
    name: "with-description",
    description: "Tokens with $description (should survive the round-trip).",
    dtcg: {
      $schema: "https://design-tokens.org/schema",
      brand: {
        primary: {
          $value: "#1a1aff",
          $type: "color",
          $description: "Primary brand color for CTAs.",
        },
      },
    },
    expectedTokenIds: Object.freeze(["brand.primary"]),
    expectedTypes: Object.freeze({ "brand.primary": "color" }),
  },
]);

// ───────────────────────────────────────────────
// Round-trip stability check
// ───────────────────────────────────────────────

/**
 * Check that a token map round-trips through DTCG export → import
 * without loss. Used as the contract test for the marketplace seam.
 *
 * Real impl calls design-tokens' exportDtcg + importDtcg; this
 * function is the assertion harness.
 */
export function assertRoundTripStable(
  originalTokenIds: readonly string[],
  importedTokenIds: readonly string[],
): { stable: boolean; missing: string[]; extra: string[] } {
  const originalSet = new Set(originalTokenIds);
  const importedSet = new Set(importedTokenIds);
  const missing = [...originalSet].filter((id) => !importedSet.has(id));
  const extra = [...importedSet].filter((id) => !originalSet.has(id));
  return {
    stable: missing.length === 0 && extra.length === 0,
    missing,
    extra,
  };
}
