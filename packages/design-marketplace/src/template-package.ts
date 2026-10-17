/**
 * @supa/design-marketplace/template-package
 * ----------------------------------------------------------------
 * A template is a versioned package (content-addressed like assets):
 *
 *   {
 *     meta: { id, semver, author, license, categories, preview
 *             assets (thumbnail per page, animated preview from
 *             real playback — not a screenshot) },
 *     doc: DesignDoc snapshot (page masters, component defs —
 *          the template-authoring subset of the op model),
 *     tokens: full token table (refs enforced — the publish gate
 *          from design-tokens already guarantees this),
 *     fonts: font requirement manifest (family+subset hashes →
 *          resolved against design-fonts; missing fonts listed
 *          honestly at install, with license/price per axis),
 *     aiManifest?: prompt-template ids the template pairs with
 *          ("expand this template with your content") — versioned
 *          server-side like all prompts,
 *     compat: { minAppVersion, op-schema version } — a template is
 *          code; it versions against the op model like code.
 *   }
 *
 * Install = download package → validate (op invariants re-run
 *   server-side on the snapshot — a template is untrusted input,
 *   same funnel as user ops) → materialize a new doc from it.
 *   No shared mutable template state: every install is a fork.
 *   Template updates are diffs against the package, offered as
 *   "update available → re-apply?" — applied as ops (the token
 *   table diff especially: re-apply re-themes for free).
 * ----------------------------------------------------------------
 */

// ───────────────────────────────────────────────
// Meta — what shows up in the listing
// ───────────────────────────────────────────────

export type TemplateCategory =
  | "deck"
  | "poster"
  | "social"
  | "doc"
  | "brand"
  | "component";

export interface TemplatePreviewAssets {
  /** Thumbnail per page (content-addressed asset hash). */
  thumbnails: string[];
  /** Animated preview from real playback (not a screenshot). */
  animatedPreview: string;
}

export interface TemplateMeta {
  /** Stable id; semver-bumped per release, not per fork. */
  id: string;
  /** Semantic version (MAJOR.MINOR.PATCH). */
  semver: string;
  author: string;
  /** SPDX license expression (e.g. "MIT", "Apache-2.0", "Proprietary"). */
  license: string;
  categories: TemplateCategory[];
  preview: TemplatePreviewAssets;
  /** Human-readable name + description (i18n by language code). */
  name: Record<string, string>;
  description: Record<string, string>;
  /** True if AI assisted in authoring — surfaced on the listing. */
  aiAssisted: boolean;
  /** Optional remix lineage (parent template id, if this is a fork). */
  derivedFrom?: string;
}

// ───────────────────────────────────────────────
// Font manifest
// ───────────────────────────────────────────────

export interface FontRequirement {
  /** Font family name (e.g. "Inter"). */
  family: string;
  /** Subset hashes (latin, latin-ext, cyrillic, etc.). */
  subsets: { name: string; hash: string }[];
  /** Per-axis license (variable fonts: weight, width, slant, etc.). */
  axes: {
    name: string;
    min: number;
    max: number;
    /** License for this axis range: "free" | "commercial" | "unknown". */
    license: "free" | "commercial" | "unknown";
    /** Price in micro-credits per install (0 for free). */
    priceMicrocredits?: number;
  }[];
}

export interface FontManifest {
  requirements: FontRequirement[];
}

// ───────────────────────────────────────────────
// AI manifest — prompt templates the template pairs with
// ───────────────────────────────────────────────

export interface AiManifest {
  /** Prompt template ids the template pairs with ("expand this template with your content"). */
  promptTemplateIds: string[];
}

// ───────────────────────────────────────────────
// Compatibility — versions against the op model like code
// ───────────────────────────────────────────────

export interface TemplateCompat {
  /** Minimum app version that can render this template. */
  minAppVersion: string;
  /** Op-schema version (matches design-model's schemaVersion). */
  opSchemaVersion: number;
}

// ───────────────────────────────────────────────
// TemplatePackage — the full artifact
// ───────────────────────────────────────────────

/**
 * A template is a versioned package. Content-addressed: the package
 * hash is sha-256 of the canonical JSON serialization. Two identical
 * packages have the same hash — cacheable like assets.
 *
 * The package is the publish/install unit. There is no shared mutable
 * template state — every install is a fork.
 */
export interface TemplatePackage {
  meta: TemplateMeta;
  /** DesignDoc snapshot (the template-authoring subset of the op model). */
  doc: unknown; // DesignDoc — opaque to this package
  /** Full token table (refs enforced by the publish gate). */
  tokens: unknown; // TokenMap — opaque to this package
  fonts: FontManifest;
  aiManifest?: AiManifest;
  compat: TemplateCompat;
  /** Content-addressed hash (sha-256 of canonical serialization). */
  packageHash: string;
}

// ───────────────────────────────────────────────
// Install = fork + validate
// ───────────────────────────────────────────────

export interface InstallResult {
  /** New doc id (the forked instance). */
  docId: string;
  /** Materialized doc (template doc copied). */
  doc: unknown;
  /** Token table copied to the new doc. */
  tokens: unknown;
  /** Missing fonts at install time (listed honestly, with license/price). */
  missingFonts: FontRequirement[];
  /** Validation results from re-running op invariants on the snapshot. */
  validation: InstallValidationResult;
}

export interface InstallValidationResult {
  ok: boolean;
  /** Invariant violations found when re-running op invariants server-side. */
  invariantViolations: { layerId: string; kind: string; message: string }[];
  /** Token table validation errors (cycles, unresolved refs). */
  tokenErrors: { tokenId: string; message: string }[];
}

/**
 * Install = download package → validate (op invariants re-run
 * server-side on the snapshot — a template is untrusted input, same
 * funnel as user ops) → materialize a new doc from it.
 *
 * The validator runs ALL the same checks as user ops:
 *   - schema-valid (design-model's validateOp)
 *   - geometry finite, in bounds
 *   - text length caps
 *   - node count cap
 *   - token table: no cycles, all refs resolve
 *
 * A malicious template can only produce garbage — never persistence
 * of garbage. Same funnel as the sync hub.
 */
export interface InstallValidator {
  validateDoc(doc: unknown): { ok: boolean; violations: InstallValidationResult["invariantViolations"] };
  validateTokens(tokens: unknown): { ok: boolean; errors: InstallValidationResult["tokenErrors"] };
}

export interface InstallOptions {
  validator: InstallValidator;
  /** Doc id generator (caller-provided for testability). */
  generateDocId: () => string;
  /** Font resolver — checks which fonts are available at install time. */
  resolveFonts: (manifest: FontManifest) => Promise<{ missing: FontRequirement[] }>;
}

export async function installTemplate(
  pkg: TemplatePackage,
  opts: InstallOptions,
): Promise<InstallResult> {
  // 1. Validate the doc snapshot (op invariants re-run server-side).
  const docValidation = opts.validator.validateDoc(pkg.doc);
  // 2. Validate the token table (cycles, unresolved refs).
  const tokenValidation = opts.validator.validateTokens(pkg.tokens);
  // 3. Resolve fonts (list missing honestly).
  const { missing: missingFonts } = await opts.resolveFonts(pkg.fonts);

  const validation: InstallValidationResult = {
    ok: docValidation.ok && tokenValidation.ok,
    invariantViolations: docValidation.violations,
    tokenErrors: tokenValidation.errors,
  };

  // Even if validation fails, we return the result — the caller
  // decides whether to materialize. A template that fails validation
  // is rejected at install, not silently materialized.
  return {
    docId: opts.generateDocId(),
    doc: pkg.doc, // forked copy
    tokens: pkg.tokens, // forked copy
    missingFonts,
    validation,
  };
}

// ───────────────────────────────────────────────
// Template updates — diffs offered as "update available → re-apply?"
// ───────────────────────────────────────────────

/**
 * Template updates are diffs against the package, offered as
 * "update available → re-apply?" — applied as ops.
 *
 * The token table diff especially: re-apply re-themes for free
 * (every ref-bearing node updates via the normal op path, the same
 * re-theme mechanism from design-tokens/bindings).
 */
export interface TemplateUpdateDiff {
  /** Old package version → new package version. */
  fromSemver: string;
  toSemver: string;
  /** Whether the update is breaking (MAJOR bump). */
  breaking: boolean;
  /** Token changes (added/removed/changed token ids). */
  tokenChanges: {
    added: string[];
    removed: string[];
    changed: string[];
  };
  /** Doc changes (op-level diff). */
  docChanges: { opType: string; layerId: string }[];
  /** Whether the update is safe to auto-apply (non-breaking + no token removals). */
  autoApplicable: boolean;
}

export function computeUpdateDiff(
  oldPkg: TemplatePackage,
  newPkg: TemplatePackage,
): TemplateUpdateDiff {
  const fromMajor = parseInt(oldPkg.meta.semver.split(".")[0] ?? "0", 10);
  const toMajor = parseInt(newPkg.meta.semver.split(".")[0] ?? "0", 10);
  const breaking = toMajor > fromMajor;

  // Token diff — the load-bearing part for re-apply. The token table
  // is opaque to this package (typed as `unknown`), so we walk both
  // tables generically and compare each token's JSON-serialized form:
  //   - `added`   = token ids in new but not in old
  //   - `removed` = token ids in old but not in new
  //   - `changed` = token ids present in both but whose serialized
  //                 definition differs (a re-theme, a recolor, etc.)
  //
  // JSON.stringify is the comparison primitive because tokens are
  // plain-data (no functions / dates that would defeat string equality).
  // A "changed" token is a MAJOR semver concern for installed docs —
  // re-applying re-themes the doc via the normal op path, but the
  // meaning of an installed doc shifts when a token it references
  // changes value. The publish gauntlet's `computeSemverBump` reads
  // `tokenChanges.changed` to flag that.
  const oldTokens = collectTokenEntries(oldPkg.tokens);
  const newTokens = collectTokenEntries(newPkg.tokens);

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [id, def] of newTokens) {
    const prev = oldTokens.get(id);
    if (prev === undefined) {
      added.push(id);
    } else if (prev !== def) {
      changed.push(id);
    }
  }
  for (const id of oldTokens.keys()) {
    if (!newTokens.has(id)) {
      removed.push(id);
    }
  }

  return {
    fromSemver: oldPkg.meta.semver,
    toSemver: newPkg.meta.semver,
    breaking,
    tokenChanges: { added, removed, changed },
    // Doc-level diff is op-level (insert/update/delete layer); the
    // host's op-model diff owns that, so we surface an empty array
    // here. Callers wanting op-level granularity pass the two doc
    // snapshots through design-model's diff before calling this.
    docChanges: [],
    // Auto-applicable iff non-breaking AND no tokens removed (a
    // removed token would break a doc that overrode or referenced it).
    autoApplicable: !breaking && removed.length === 0,
  };
}

// ───────────────────────────────────────────────
// Token-table walker (shared with publish.ts provenance gate)
// ───────────────────────────────────────────────

/**
 * Visit every (id, definition) pair in an opaque token table.
 *
 * The token table is typed as `unknown` in this package — different
 * hosts store it as a `Map<string, TokenDef>`, a `Record<string, TokenDef>`,
 * or `{ mapId, tokens: Map | Record }`. This walker handles all three
 * shapes so the publish gauntlet + computeUpdateDiff can inspect
 * tokens without needing design-tokens as a hard dep.
 */
export function walkTokenTable(
  tokens: unknown,
  visit: (id: string, def: unknown) => void,
): void {
  if (!tokens || typeof tokens !== "object") return;
  // Handle Map<string, def>.
  if (tokens instanceof Map) {
    for (const [id, def] of tokens.entries()) {
      if (typeof id === "string") visit(id, def);
    }
    return;
  }
  // Handle { tokens: Map | Record } wrapper.
  const maybeWrapped = tokens as { tokens?: unknown };
  const inner = maybeWrapped.tokens ?? tokens;
  if (inner instanceof Map) {
    for (const [id, def] of inner.entries()) {
      if (typeof id === "string") visit(id, def);
    }
    return;
  }
  if (inner && typeof inner === "object") {
    for (const [id, def] of Object.entries(inner as Record<string, unknown>)) {
      visit(id, def);
    }
  }
}

/**
 * Collect every token in the table as `id → JSON-serialized definition`.
 * Used by `computeUpdateDiff` to compare old vs new token tables by
 * structural equality (two tokens are "the same" iff their serialized
 * forms match exactly).
 */
function collectTokenEntries(tokens: unknown): Map<string, string> {
  const out = new Map<string, string>();
  walkTokenTable(tokens, (id, def) => {
    out.set(id, safeStableStringify(def));
  });
  return out;
}

/**
 * Stable JSON serialization — sorts object keys so two structurally
 * equal tokens produce the same string regardless of insertion order.
 * Falls back to `JSON.stringify` if sorting fails (e.g., cycles —
 * which the publish gate already rejects upstream).
 */
function safeStableStringify(value: unknown): string {
  try {
    return JSON.stringify(sortKeys(value));
  } catch {
    return JSON.stringify(value) ?? "";
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
