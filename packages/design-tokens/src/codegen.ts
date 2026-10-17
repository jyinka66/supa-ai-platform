/**
 * @supa/design-tokens/codegen
 * ----------------------------------------------------------------
 * design-io's copy-as-code now emits tokens as CSS custom properties:
 *   :root { --brand-primary: ...; --space-2: ... }
 * literals only at :root, refs everywhere else, so the generated code
 * inherits the same re-theme property: change :root, whole page
 * re-themes. Design doc token variants map to media queries
 * (@media (prefers-color-scheme)) — dark mode in codegen falls out
 * of the same variant table.
 *
 * Design-system sync (the marketplace seam): a template's token
 * table exports as a standard tokens JSON (W3C DTCG format) —
 * importable into Style Dictionary, Tailwind config, or any
 * consumer. The tool is a token source of truth, not a token silo;
 * round-trip import of DTCG files maps into the same schema with
 * provenance: 'import'.
 * ----------------------------------------------------------------
 */

import type { Token, TokenMap, VariantName, TokenType } from "./schema.js";

// ───────────────────────────────────────────────
// CSS custom property emission
// ───────────────────────────────────────────────

/**
 * Emit a token map as CSS custom properties under :root.
 *
 * - Literals go to :root (the base values).
 * - Variant-specific overrides go to @media (prefers-color-scheme)
 *   blocks so dark mode in codegen falls out of the same variant
 *   table.
 * - Refs stay as `var(--other-token)` — the generated CSS inherits
 *   the same re-theme property: change :root, whole page re-themes.
 */
export function emitCssCustomProperties(map: TokenMap): string {
  const lines: string[] = [];
  lines.push(":root {");
  for (const [id, token] of map.tokens) {
    const varName = tokenIdToCssVar(id);
    if (token.value.kind === "literal") {
      lines.push(`  --${varName}: ${token.value.value};`);
    } else {
      // Ref — emit as var() reference.
      lines.push(`  --${varName}: var(--${tokenIdToCssVar(token.value.token)});`);
    }
  }
  lines.push("}");

  // Emit variant overrides as @media blocks.
  const variants: VariantName[] = ["dark", "contrast-high"];
  for (const variant of variants) {
    const overrides = [...map.tokens.values()].filter((t) => t.variants?.[variant]);
    if (overrides.length === 0) continue;
    const mediaQuery = variantToMediaQuery(variant);
    lines.push("");
    lines.push(mediaQuery + " {");
    lines.push("  :root {");
    for (const token of overrides) {
      const v = token.variants![variant]!;
      const varName = tokenIdToCssVar(token.id);
      if (v.kind === "literal") {
        lines.push(`    --${varName}: ${v.value};`);
      } else {
        lines.push(`    --${varName}: var(--${tokenIdToCssVar(v.token)});`);
      }
    }
    lines.push("  }");
    lines.push("}");
  }

  return lines.join("\n");
}

function tokenIdToCssVar(id: string): string {
  // brand.primary → brand-primary; user.surface.1 → user-surface-1
  return id.replace(/\./g, "-");
}

function variantToMediaQuery(variant: VariantName): string {
  switch (variant) {
    case "dark":
      return "@media (prefers-color-scheme: dark)";
    case "contrast-high":
      return "@media (prefers-contrast: more)";
    case "light":
      return "@media (prefers-color-scheme: light)";
  }
}

// ───────────────────────────────────────────────
// W3C DTCG (Design Tokens Community Group) format
// ───────────────────────────────────────────────

/**
 * W3C DTCG tokens JSON format.
 * Spec: https://design-tokens.org/format/
 *
 * The tool is a token source of truth, not a silo. Round-trip
 * import of DTCG files maps into the same schema with
 * provenance: 'import'.
 */
export interface DtcgToken {
  $value: string | number;
  $type?: string;
  $description?: string;
  /** Variant-specific values (DTCG calls these "extensions" or "themes"). */
  [variant: string]: unknown;
}

export interface DtcgTokenGroup {
  [tokenId: string]: DtcgToken | DtcgTokenGroup;
}

export interface DtcgFile {
  $schema?: string;
  [namespace: string]: DtcgTokenGroup | string | undefined;
}

const TYPE_TO_DTCG: Record<TokenType, string> = {
  color: "color",
  space: "dimension",
  radius: "dimension",
  typography: "typography",
  shadow: "shadow",
  duration: "duration",
};

const DTCG_TO_TYPE: Record<string, TokenType> = {
  color: "color",
  dimension: "space",
  typography: "typography",
  shadow: "shadow",
  duration: "duration",
};

/**
 * Export a token map as a DTCG-format JSON object.
 *
 * Namespacing: the map's ids are split by "." into nested groups.
 * e.g. "brand.primary" → { brand: { primary: { $value, $type } } }
 */
export function exportDtcg(map: TokenMap): DtcgFile {
  const root: DtcgFile = { $schema: "https://design-tokens.org/schema" };
  for (const [id, token] of map.tokens) {
    const parts = id.split(".");
    let group: DtcgTokenGroup = root as DtcgTokenGroup;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      const existing = group[part];
      if (!existing || typeof existing === "string") {
        group[part] = {} as DtcgTokenGroup;
      }
      group = group[part] as DtcgTokenGroup;
    }
    const leafName = parts[parts.length - 1]!;
    const dtcgToken: DtcgToken = {
      $value: token.value.kind === "literal" ? token.value.value : `$${token.value.token}`,
      $type: TYPE_TO_DTCG[token.type],
    };
    if (token.description) {
      dtcgToken.$description = token.description;
    }
    // Variant-specific values as nested $value objects (DTCG convention).
    if (token.variants) {
      for (const [variant, v] of Object.entries(token.variants)) {
        if (!v) continue;
        dtcgToken[`$value.${variant}`] = v.kind === "literal" ? v.value : `$${v.token}`;
      }
    }
    group[leafName] = dtcgToken;
  }
  return root;
}

/**
 * Import a DTCG-format JSON object into the token schema.
 *
 * Imported tokens carry provenance: 'import' — they're treated as
 * a token source of truth, not user-customizable. Re-exporting
 * produces the same JSON (round-trip stable).
 */
export function importDtcg(
  file: DtcgFile,
  opts?: { templateId?: string; namespacePrefix?: string },
): Token[] {
  const tokens: Token[] = [];
  const nsPrefix = opts?.namespacePrefix;

  function walk(group: DtcgTokenGroup, prefix: string): void {
    for (const [key, value] of Object.entries(group)) {
      if (typeof value === "string") continue;
      const v = value as DtcgToken | DtcgTokenGroup;
      // Is this a leaf token (has $value)?
      if ("$value" in v && v.$value !== undefined) {
        const id = nsPrefix ? `${nsPrefix}.${prefix}${key}` : `${prefix}${key}`;
        const rawValue = v.$value;
        const dtcgType = typeof v.$type === "string" ? v.$type : "color";
        const type = DTCG_TO_TYPE[dtcgType] ?? "color";
        // Refs are prefixed with $ in DTCG export.
        const tokenValue =
          typeof rawValue === "string" && rawValue.startsWith("$")
            ? { kind: "ref" as const, token: rawValue.slice(1) }
            : { kind: "literal" as const, value: String(rawValue) };

        // Parse variant-specific $value.<variant> entries.
        const variants: Partial<Record<VariantName, typeof tokenValue>> = {};
        for (const variant of ["light", "dark", "contrast-high"] as VariantName[]) {
          const variantKey = `$value.${variant}`;
          if (variantKey in v) {
            const variantRaw = (v as Record<string, unknown>)[variantKey];
            if (typeof variantRaw === "string") {
              if (variantRaw.startsWith("$")) {
                variants[variant] = { kind: "ref", token: variantRaw.slice(1) };
              } else {
                variants[variant] = { kind: "literal", value: variantRaw };
              }
            } else if (typeof variantRaw === "number") {
              variants[variant] = { kind: "literal", value: String(variantRaw) };
            }
          }
        }

        // $description is typed as string|undefined in DtcgToken, but the
        // index signature widens it. Cast to string for the Token shape.
        const description = typeof v.$description === "string" ? v.$description : undefined;
        const tokenRecord: Token = {
          id,
          type,
          value: tokenValue,
          ...(description !== undefined ? { description } : {}),
          ...(Object.keys(variants).length > 0 ? { variants } : {}),
          provenance: {
            source: "import",
            ...(opts?.templateId ? { templateId: opts.templateId } : {}),
          },
        };
        tokens.push(tokenRecord);
      } else {
        // It's a nested group — recurse.
        walk(v as DtcgTokenGroup, `${prefix}${key}.`);
      }
    }
  }

  for (const [key, value] of Object.entries(file)) {
    if (key === "$schema" || typeof value === "string") continue;
    walk(value as DtcgTokenGroup, `${key}.`);
  }

  return tokens;
}

/**
 * Round-trip stability check: export then import should produce the
 * same set of tokens (modulo provenance). Used by tests + as a
 * contract check on the marketplace seam.
 */
export function isRoundTripStable(map: TokenMap): boolean {
  const exported = exportDtcg(map);
  const imported = importDtcg(exported);
  if (imported.length !== map.tokens.size) return false;
  // Check each token round-trips with the same id + value + type.
  for (const importedToken of imported) {
    const original = map.tokens.get(importedToken.id);
    if (!original) return false;
    if (original.type !== importedToken.type) return false;
    if (original.value.kind !== importedToken.value.kind) return false;
    if (original.value.kind === "literal" && importedToken.value.kind === "literal") {
      if (original.value.value !== importedToken.value.value) return false;
    }
    if (original.value.kind === "ref" && importedToken.value.kind === "ref") {
      if (original.value.token !== importedToken.value.token) return false;
    }
  }
  return true;
}
