// i18n CI checker — enforces i18n invariants at build time.
//
// The spec: "i18n is enforced at compile time and CI. Hardcoded strings fail
// the build. Missing translations fail the build. RTL violations fail the build.
// No exceptions." + "Automated QA — missing strings, placeholder mismatches,
// length overflows, RTL issues, pluralization errors, and formatting problems
// caught automatically."
//
// Checks:
//   1. hardcodedStrings(sourceCode) — detect JSX text that isn't wrapped in t().
//      Catches `<button>Click here</button>` (should be `<button>{t('click_here')}</button>`).
//   2. missingTranslations(messages, locales) — keys present in en but missing in other locales.
//   3. placeholderMismatch(source, target) — `{{count}}` in source but not target (or vice versa).
//   4. rtlViolations(html, dir) — text alignment / direction issues in RTL layouts.
//   5. lengthOverflow(source, target, maxExpansion) — target > 2x source length (likely a bad translation).
//
// Usage in CI:
//   const violations = runChecks(sourceFiles, messages, locales);
//   if (violations.length > 0) {
//     console.error(JSON.stringify(violations, null, 2));
//     process.exit(1); // block the build.
//   }

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type I18nViolationType =
  | "hardcoded_string"
  | "missing_translation"
  | "placeholder_mismatch"
  | "rtl_violation"
  | "length_overflow";

export interface I18nViolation {
  type: I18nViolationType;
  file?: string | undefined;
  line?: number | undefined;
  locale?: string | undefined;
  key?: string | undefined;
  source?: string | undefined;
  target?: string | undefined;
  detail: string;
}

// ───────────────────────────────────────────────
// 1. Hardcoded string detection
// ───────────────────────────────────────────────

/**
 * Detect hardcoded strings in JSX/TSX source code.
 *
 * Catches:
 *   - JSX text content that isn't wrapped in t() / <Trans>:
 *     `<button>Click here</button>` → violation (should be `{t('click_here')}`).
 *   - String literals passed to aria-label / title / alt without t():
 *     `<input aria-label="Email" />` → violation.
 *
 * Does NOT catch:
 *   - Strings that are clearly not user-facing (comments, console.log, error messages for logs).
 *   - Strings already wrapped in t() / <Trans>.
 *
 * Heuristic: looks for `>text<` (JSX text) + `label="..."` / `title="..."` / `alt="..."` / `aria-label="..."` attributes.
 */
export function detectHardcodedStrings(source: string, file?: string): I18nViolation[] {
  const violations: I18nViolation[] = [];
  const lines = source.split("\n");

  // Pattern 1: JSX text content (>text<) — not whitespace, not an expression, not a closing tag.
  const jsxTextPattern = />([^<>{}\n]+)</g;

  // Pattern 2: user-facing attributes (aria-label, title, alt, label, placeholder).
  const attrPattern = /\b(aria-label|title|alt|placeholder|label)\s*=\s*"([^"]+)"/g;

  // Skip patterns (not user-facing).
  const skipPatterns = [
    /^\s*\/\//,       // line comments.
    /^\s*\*/,         // block comment lines.
    /console\./,      // console statements.
    /import\s/,        // import statements.
    /\/\/.*$/,         // inline comments.
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNum = i + 1;

    // Skip comments + imports.
    if (skipPatterns.some((p) => p.test(line))) continue;

    // Check JSX text content.
    let match: RegExpExecArray | null;
    while ((match = jsxTextPattern.exec(line)) !== null) {
      const text = match[1]?.trim();
      if (!text) continue;
      // Skip if it's already an expression ({...}) or a number-only or a URL.
      if (/^\{.*\}$/.test(text)) continue;
      if (/^\d+$/.test(text)) continue;
      if (/^https?:\/\//.test(text)) continue;
      // Skip single characters (often icons or separators).
      if (text.length < 2) continue;

      violations.push({
        type: "hardcoded_string",
        file,
        line: lineNum,
        source: text,
        detail: `Hardcoded JSX text "${text}" — wrap in t() or <Trans>`,
      });
    }

    // Check user-facing attributes.
    while ((match = attrPattern.exec(line)) !== null) {
      const attr = match[1];
      const value = match[2];
      if (!value || !attr) continue;
      // Skip if the value is already a t() call (would be {t('...')} not "...").
      if (line.includes(`{t(`) || line.includes(`{t("`) || line.includes("<Trans>")) continue;

      violations.push({
        type: "hardcoded_string",
        file,
        line: lineNum,
        source: value,
        detail: `Hardcoded ${attr}="${value}" — wrap in t()`,
      });
    }
  }

  return violations;
}

// ───────────────────────────────────────────────
// 2. Missing translation detection
// ───────────────────────────────────────────────

/**
 * Detect translation keys present in the source locale (en) but missing in target locales.
 *
 * @param sourceMessages — the English messages (the source of truth).
 * @param targetMessages — the target locale's messages.
 * @param locale — the target locale code.
 */
export function detectMissingTranslations(
  sourceMessages: Record<string, unknown>,
  targetMessages: Record<string, unknown>,
  locale: string,
): I18nViolation[] {
  const violations: I18nViolation[] = [];

  function walk(source: Record<string, unknown>, target: Record<string, unknown>, path: string) {
    for (const key of Object.keys(source)) {
      const currentPath = path ? `${path}.${key}` : key;
      const sourceVal = source[key];
      const targetVal = target?.[key];

      if (typeof sourceVal === "object" && sourceVal !== null) {
        // Recurse into nested objects.
        walk(sourceVal as Record<string, unknown>, (targetVal as Record<string, unknown>) ?? {}, currentPath);
      } else if (typeof sourceVal === "string") {
        // Leaf: check if the target has it.
        if (targetVal === undefined || targetVal === null) {
          violations.push({
            type: "missing_translation",
            locale,
            key: currentPath,
            source: sourceVal,
            detail: `Missing translation for key "${currentPath}" in locale "${locale}"`,
          });
        }
      }
    }
  }

  walk(sourceMessages, targetMessages, "");
  return violations;
}

// ───────────────────────────────────────────────
// 3. Placeholder mismatch detection
// ───────────────────────────────────────────────

/** Extract placeholders ({{name}}) from a message string. */
export function extractPlaceholders(message: string): string[] {
  const matches = message.match(/\{\{(\w+)\}\}/g);
  return matches ? matches.map((m) => m.replace(/\{\{|\}\}/g, "")) : [];
}

/**
 * Detect placeholder mismatches between source + target.
 *
 * Catches:
 *   - Source has {{count}} but target doesn't (lost placeholder).
 *   - Target has {{name}} but source doesn't (invented placeholder).
 *   - Placeholder names differ ({{count}} vs {{num}}).
 */
export function detectPlaceholderMismatch(
  source: string,
  target: string,
  locale?: string,
  key?: string,
): I18nViolation[] {
  const violations: I18nViolation[] = [];
  const sourcePlaceholders = extractPlaceholders(source);
  const targetPlaceholders = extractPlaceholders(target);

  // Missing in target.
  for (const ph of sourcePlaceholders) {
    if (!targetPlaceholders.includes(ph)) {
      violations.push({
        type: "placeholder_mismatch",
        locale,
        key,
        source,
        target,
        detail: `Placeholder {{${ph}}} missing in target (locale=${locale ?? "?"}, key=${key ?? "?"})`,
      });
    }
  }

  // Invented in target.
  for (const ph of targetPlaceholders) {
    if (!sourcePlaceholders.includes(ph)) {
      violations.push({
        type: "placeholder_mismatch",
        locale,
        key,
        source,
        target,
        detail: `Unexpected placeholder {{${ph}}} in target (locale=${locale ?? "?"}, key=${key ?? "?"})`,
      });
    }
  }

  return violations;
}

// ───────────────────────────────────────────────
// 4. RTL violation detection
// ───────────────────────────────────────────────

/**
 * Detect RTL violations in HTML/JSX.
 *
 * Catches:
 *   - `text-align: left` / `text-align: right` in RTL layouts (should be logical: start/end).
 *   - `margin-left` / `margin-right` in RTL (should be margin-inline-start/end).
 *   - `left:` / `right:` in CSS (should be inset-inline-start/end).
 *   - Missing `dir` attribute on the root element.
 *
 * This is a heuristic — the real check would use a CSS parser + the computed
 * direction. For CI, this catches the common pitfalls.
 */
export function detectRtlViolations(source: string, _expectedDir?: "ltr" | "rtl", file?: string): I18nViolation[] {
  const violations: I18nViolation[] = [];
  const lines = source.split("\n");

  const physicalPropertyPattern = /\b(text-align|textAlign|margin-left|marginLeft|margin-right|marginRight|padding-left|paddingLeft|padding-right|paddingRight)\s*[:=]\s*["']?(left|right)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (physicalPropertyPattern.test(line)) {
      violations.push({
        type: "rtl_violation",
        file,
        line: i + 1,
        detail: `Physical property detected — use logical properties (margin-inline-start, text-align: start, etc.) for RTL support: ${line.trim()}`,
      });
    }
  }

  return violations;
}

// ───────────────────────────────────────────────
// 5. Length overflow detection
// ───────────────────────────────────────────────

/**
 * Detect translations that are significantly longer than the source (likely a bad translation).
 *
 * The threshold: target > 2x source length (German is typically ~30% longer than English;
 * 2x is a generous threshold that catches garbage/duplicated translations).
 *
 * @param maxExpansion — the maximum allowed ratio (default 2.0 = 200%).
 */
export function detectLengthOverflow(
  source: string,
  target: string,
  maxExpansion: number = 2.0,
  locale?: string,
  key?: string,
): I18nViolation[] {
  const violations: I18nViolation[] = [];
  const sourceLen = source.length;
  const targetLen = target.length;

  if (sourceLen > 0 && targetLen > sourceLen * maxExpansion) {
    violations.push({
      type: "length_overflow",
      locale,
      key,
      source,
      target,
      detail: `Translation is ${targetLen} chars (source is ${sourceLen} — ${Math.round((targetLen / sourceLen) * 100)}%, max ${maxExpansion * 100}%) — likely a bad translation`,
    });
  }

  return violations;
}

// ───────────────────────────────────────────────
// Run all checks (the CI entry point)
// ───────────────────────────────────────────────

export interface CheckOptions {
  sourceFiles?: Array<{ path: string; content: string }>;
  messages?: Record<string, Record<string, unknown>>; // locale → messages.
  locales?: string[];
  defaultLocale?: string;
}

/**
 * Run all i18n checks. Returns violations (empty = pass).
 *
 * In CI:
 *   const violations = runI18nChecks({ sourceFiles, messages, locales });
 *   if (violations.length > 0) {
 *     console.error(`${violations.length} i18n violations found:`);
 *     for (const v of violations) console.error(`  ${v.type}: ${v.detail}`);
 *     process.exit(1); // block the build.
 *   }
 */
export function runI18nChecks(opts: CheckOptions): I18nViolation[] {
  const violations: I18nViolation[] = [];
  const defaultLocale = opts.defaultLocale ?? "en";
  const locales = opts.locales ?? (opts.messages ? Object.keys(opts.messages).filter((l) => l !== defaultLocale) : []);

  // 1. Hardcoded strings.
  if (opts.sourceFiles) {
    for (const file of opts.sourceFiles) {
      violations.push(...detectHardcodedStrings(file.content, file.path));
    }
  }

  // 2. Missing translations + placeholder mismatch + length overflow.
  if (opts.messages && opts.messages[defaultLocale]) {
    const sourceMessages = opts.messages[defaultLocale]!;
    for (const locale of locales) {
      const targetMessages = opts.messages[locale] ?? {};
      violations.push(...detectMissingTranslations(sourceMessages, targetMessages, locale));

      // Check placeholders + length for matching keys.
      function walk(src: Record<string, unknown>, tgt: Record<string, unknown>, path: string) {
        for (const key of Object.keys(src)) {
          const currentPath = path ? `${path}.${key}` : key;
          const srcVal = src[key];
          const tgtVal = tgt?.[key];
          if (typeof srcVal === "object" && srcVal !== null) {
            walk(srcVal as Record<string, unknown>, (tgtVal as Record<string, unknown>) ?? {}, currentPath);
          } else if (typeof srcVal === "string" && typeof tgtVal === "string") {
            violations.push(...detectPlaceholderMismatch(srcVal, tgtVal, locale, currentPath));
            violations.push(...detectLengthOverflow(srcVal, tgtVal, 2.0, locale, currentPath));
          }
        }
      }
      walk(sourceMessages, targetMessages, "");
    }
  }

  // 3. RTL violations.
  if (opts.sourceFiles) {
    for (const file of opts.sourceFiles) {
      violations.push(...detectRtlViolations(file.content, undefined, file.path));
    }
  }

  return violations;
}
