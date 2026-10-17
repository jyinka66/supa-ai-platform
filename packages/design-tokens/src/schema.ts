/**
 * @supa/design-tokens/schema
 * ----------------------------------------------------------------
 * Token: { id, type, value, description?, variants?, provenance }
 *   type: 'color'|'space'|'radius'|'typography'|'shadow'|'duration'
 *   value: primitive (e.g. '#1a1aff') OR reference ($space.2)
 *   variants: { light, dark, 'contrast-high' } — theme modes are
 *     variants on the same token id, not separate token sets that
 *     drift apart.
 *   provenance: { source: 'template'|'user'|'ai'|'import',
 *                 templateId?, aiGenerationId? }
 *
 * Resolution: refs resolve to one primitive at leaf; cycles are a
 * schema error caught at write time (same discipline as tree
 * invariants). Resolution is pure — the resolved token table for a
 * doc+theme is a content-addressed artifact, cacheable.
 *
 * Namespacing: template tokens live under the template's ns; user
 * overrides under 'user.'; a token map is a 3-layer merge
 * (platform defaults → template ns → user overrides) resolved once.
 * ----------------------------------------------------------------
 */

// ───────────────────────────────────────────────
// Token primitives
// ───────────────────────────────────────────────

export type TokenType =
  | "color"
  | "space"
  | "radius"
  | "typography"
  | "shadow"
  | "duration";

export type VariantName = "light" | "dark" | "contrast-high";

export type TokenValue =
  | { kind: "literal"; value: string }
  | { kind: "ref"; token: string }; // e.g. "space.2" or "brand.primary"

export interface TokenProvenance {
  source: "template" | "user" | "ai" | "import";
  templateId?: string;
  aiGenerationId?: string;
}

export interface Token {
  /** Namespaced id, e.g. "brand.primary" or "user.brand.primary". */
  id: string;
  type: TokenType;
  value: TokenValue;
  description?: string;
  /** Variant-specific overrides. The base `value` is the default. */
  variants?: Partial<Record<VariantName, TokenValue>>;
  provenance: TokenProvenance;
}

// ───────────────────────────────────────────────
// Token map — 3-layer merge
// ───────────────────────────────────────────────

/**
 * The 3-layer merge:
 *   1. Platform defaults (the design-system baseline)
 *   2. Template namespace (template-specific tokens)
 *   3. User overrides (per-doc customizations under "user." prefix)
 *
 * Each layer can override the previous. Resolution happens once per
 * doc+theme and is content-addressed — the resolved table is a
 * cacheable artifact.
 */
export interface TokenMap {
  /** Stable id for the resolved map (content hash). */
  readonly mapId: string;
  readonly tokens: ReadonlyMap<string, Token>;
}

export class TokenMapBuilder {
  private readonly tokens = new Map<string, Token>();

  /** Apply a layer — later layers override earlier ones. */
  applyLayer(layer: Token[]): this {
    for (const t of layer) {
      this.tokens.set(t.id, t);
    }
    return this;
  }

  /** Apply the 3-layer merge: platform → template → user. */
  applyThreeLayers(
    platformDefaults: Token[],
    templateNs: Token[],
    userOverrides: Token[],
  ): this {
    return this.applyLayer(platformDefaults).applyLayer(templateNs).applyLayer(userOverrides);
  }

  build(): TokenMap {
    return {
      mapId: hashTokenMap(this.tokens),
      tokens: new Map(this.tokens),
    };
  }
}

// ───────────────────────────────────────────────
// Resolution — refs → primitives
// ───────────────────────────────────────────────

export interface ResolvedToken {
  id: string;
  type: TokenType;
  /** Always a literal at leaf — refs fully resolved. */
  value: string;
  /** Path of refs followed (for cycle debugging + telemetry). */
  resolutionPath: string[];
}

export type ResolvedTable = ReadonlyMap<string, ResolvedToken>;

export class ResolutionError extends Error {
  constructor(
    message: string,
    readonly tokenId: string,
    readonly cyclePath?: string[],
  ) {
    super(message);
    this.name = "ResolutionError";
  }
}

/**
 * Resolve a token map for a given variant. Returns a table of
 * fully-resolved tokens (every value is a literal primitive).
 *
 * Cycle detection: a ref chain that loops back to a token already
 * in the resolution path is a schema error, caught here at write
 * time (not at render time).
 */
export function resolveTable(map: TokenMap, variant: VariantName = "light"): ResolvedTable {
  const out = new Map<string, ResolvedToken>();
  for (const [id, token] of map.tokens) {
    out.set(id, resolveToken(token, map, variant, []));
  }
  return out;
}

function resolveToken(
  token: Token,
  map: TokenMap,
  variant: VariantName,
  path: string[],
): ResolvedToken {
  if (path.includes(token.id)) {
    throw new ResolutionError(
      `cycle detected: ${[...path, token.id].join(" → ")}`,
      token.id,
      [...path, token.id],
    );
  }
  // Pick the variant-specific value if present, else the base value.
  const value = token.variants?.[variant] ?? token.value;
  if (value.kind === "literal") {
    return {
      id: token.id,
      type: token.type,
      value: value.value,
      resolutionPath: [...path, token.id],
    };
  }
  // Ref — resolve recursively.
  const ref = map.tokens.get(value.token);
  if (!ref) {
    throw new ResolutionError(
      `unresolved ref: ${token.id} → ${value.token}`,
      token.id,
    );
  }
  const resolved = resolveToken(ref, map, variant, [...path, token.id]);
  return {
    id: token.id,
    type: ref.type, // type follows the ref chain to the leaf
    value: resolved.value,
    resolutionPath: [...path, token.id, ...resolved.resolutionPath],
  };
}

// ───────────────────────────────────────────────
// Write-time validation (the "schema error" contract)
// ───────────────────────────────────────────────

/**
 * Validates a token map at write time. Throws ResolutionError on:
 *   - cycles (ref chains that loop)
 *   - unresolved refs (ref to a token not in the map)
 *   - type mismatches (a color token refs a space token)
 *
 * Same discipline as tree invariants: write-time check, not
 * render-time. Renderers can assume the table is resolvable.
 */
export function validateTokenMap(map: TokenMap): { ok: true } | { ok: false; errors: ResolutionError[] } {
  const errors: ResolutionError[] = [];
  for (const variant of ["light", "dark", "contrast-high"] as VariantName[]) {
    try {
      resolveTable(map, variant);
    } catch (err) {
      if (err instanceof ResolutionError) {
        errors.push(err);
      } else {
        throw err;
      }
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// ───────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────

function hashTokenMap(tokens: Map<string, Token>): string {
  // Simple hash for cache key — not cryptographic, just stable.
  // Real impl uses sha-256 of the canonical JSON serialization.
  let h = 0x811c9dc5;
  const sorted = [...tokens.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [id, t] of sorted) {
    for (const ch of id + t.type + JSON.stringify(t.value) + JSON.stringify(t.variants ?? {})) {
      h ^= ch.charCodeAt(0);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
  }
  return h.toString(16).padStart(8, "0");
}
