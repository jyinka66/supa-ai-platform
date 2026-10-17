/**
 * @supa/test-fixtures/golden
 * ----------------------------------------------------------------
 * Golden test harness configuration, consolidated from
 * @supa/design-render's golden test infrastructure. Defines:
 *
 *   - Determinism rules (same input → same output, no timestamps,
 *     no random IDs, no locale-dependent formatting)
 *   - Client/server parity rules (same SVG output on Node + browser)
 *   - RTL canary corpus (RTL text rendering must not break)
 *   - Tolerance thresholds (pixel-perfect vs "close enough")
 *
 * The golden test harness runs in CI: render a doc to SVG, compare
 * against the golden snapshot, fail if the diff exceeds tolerance.
 * The harness is the regression gate for render changes.
 * ----------------------------------------------------------------
 */

// ───────────────────────────────────────────────
// Golden test config
// ───────────────────────────────────────────────

export interface GoldenTestConfig {
  /** Snapshot directory (relative to the package root). */
  readonly snapshotDir: string;
  /** Max pixel diff allowed before the test fails (0 = pixel-perfect). */
  readonly pixelDiffTolerance: number;
  /** Max dimension diff allowed (px) before the test fails. */
  readonly dimensionTolerance: number;
  /** Whether to update snapshots on failure (CI = false; local = true with --update flag). */
  readonly updateSnapshots: boolean;
  /** Render environments to test for parity. */
  readonly environments: readonly ("node" | "browser")[];
}

export const GOLDEN_TEST_CONFIG: GoldenTestConfig = Object.freeze({
  snapshotDir: "__golden_snapshots__",
  pixelDiffTolerance: 0,
  dimensionTolerance: 0,
  updateSnapshots: false,
  environments: Object.freeze(["node", "browser"] as const),
});

// ───────────────────────────────────────────────
// Golden parity rules — determinism + client/server parity
// ───────────────────────────────────────────────

export interface GoldenParityRule {
  readonly name: string;
  readonly description: string;
  readonly category: "determinism" | "parity" | "rtl";
}

export const GOLDEN_PARITY_RULES: readonly GoldenParityRule[] = Object.freeze([
  {
    name: "no-timestamps-in-output",
    description:
      "Rendered SVG must not contain timestamps, random IDs, or Date.now() calls. " +
      "Same input → same output, byte-for-byte, across runs.",
    category: "determinism",
  },
  {
    name: "no-locale-dependent-formatting",
    description:
      "Number formatting, date formatting, and text shaping must not depend on the " +
      "runtime locale. Use explicit Intl.NumberFormat with a pinned locale, or format " +
      "as plain numbers (no thousands separators).",
    category: "determinism",
  },
  {
    name: "stable-ids",
    description:
      "Layer IDs in the rendered SVG must be deterministic (based on the doc's layer " +
      "tree, not on a ULID or Math.random()). The same doc renders the same IDs every time.",
    category: "determinism",
  },
  {
    name: "node-browser-svg-parity",
    description:
      "The SVG output from the Node renderer must be byte-identical to the browser " +
      "renderer's output. The test harness renders the same doc in both environments " +
      "and diffs the output. Any divergence is a parity bug.",
    category: "parity",
  },
  {
    name: "font-metrics-parity",
    description:
      "Text measurement (font metrics) must be identical on Node + browser. The " +
      "design-render package uses Canvas API on browser and fontkit on Node; the " +
      "golden test asserts both produce the same text bounds for the same input.",
    category: "parity",
  },
  {
    name: "rtl-text-canary",
    description:
      "RTL (right-to-left) text must render correctly. The canary corpus includes " +
      "Arabic + Hebrew text snippets; the golden snapshot verifies the text bounds + " +
      "direction attribute match expectations.",
    category: "rtl",
  },
  {
    name: "mixed-direction-text",
    description:
      "Mixed LTR/RTL text (e.g. English text inside an Arabic doc) must render with " +
      "correct bidi ordering. The canary corpus includes mixed-direction snippets.",
    category: "rtl",
  },
]);

// ───────────────────────────────────────────────
// RTL canary corpus — text snippets that must render correctly
// ───────────────────────────────────────────────

export interface RtlCanarySnippet {
  readonly name: string;
  readonly text: string;
  readonly expectedDirection: "ltr" | "rtl";
  readonly expectedTextLength: number;
}

export const RTL_CANARY_CORPUS: readonly RtlCanarySnippet[] = Object.freeze([
  {
    name: "arabic-simple",
    text: "مرحبا بالعالم",
    expectedDirection: "rtl",
    expectedTextLength: 13,
  },
  {
    name: "hebrew-simple",
    text: "שלום עולם",
    expectedDirection: "rtl",
    expectedTextLength: 9,
  },
  {
    name: "mixed-ltr-in-rtl",
    text: "Hello مرحبا",
    expectedDirection: "rtl",
    expectedTextLength: 11,
  },
  {
    name: "mixed-rtl-in-ltr",
    text: "مرحبا World",
    expectedDirection: "ltr",
    expectedTextLength: 11,
  },
  {
    name: "english-ltr",
    text: "Hello World",
    expectedDirection: "ltr",
    expectedTextLength: 11,
  },
]);

// ───────────────────────────────────────────────
// Golden snapshot comparison
// ───────────────────────────────────────────────

export interface GoldenComparisonResult {
  readonly passed: boolean;
  readonly pixelDiff: number;
  readonly dimensionDiff: number;
  readonly message: string;
}

/**
 * Compare a rendered output against a golden snapshot. Returns
 * passed=true if the pixel diff + dimension diff are within
 * tolerance. This is the regression gate — any render change
 * that exceeds tolerance fails CI.
 *
 * Real impl uses pixelmatch (PNG diff) + dimension comparison.
 * This function is the contract for the harness.
 */
export function compareGolden(
  actual: { svg: string; width: number; height: number },
  expected: { svg: string; width: number; height: number },
  config: GoldenTestConfig = GOLDEN_TEST_CONFIG,
): GoldenComparisonResult {
  const widthDiff = Math.abs(actual.width - expected.width);
  const heightDiff = Math.abs(actual.height - expected.height);
  const dimensionDiff = Math.max(widthDiff, heightDiff);

  if (dimensionDiff > config.dimensionTolerance) {
    return {
      passed: false,
      pixelDiff: 0,
      dimensionDiff,
      message: `dimension diff ${dimensionDiff}px exceeds tolerance ${config.dimensionTolerance}px (expected ${expected.width}×${expected.height}, got ${actual.width}×${actual.height})`,
    };
  }

  // String comparison (real impl does PNG pixel diff; this is the
  // contract for the test harness).
  const svgMatches = actual.svg === expected.svg;
  return {
    passed: svgMatches,
    pixelDiff: svgMatches ? 0 : 1,
    dimensionDiff,
    message: svgMatches
      ? "golden snapshot matches"
      : "SVG output differs from golden snapshot (string comparison; real impl uses pixelmatch)",
  };
}
