// Accessibility (a11y) CI checker — WCAG AA enforcement.
//
// The spec: "Accessibility is a system property, not a checklist. Every
// component, every page, every flow is tested by automated a11y tools in CI,
// and audited manually on a schedule. Regressions block deploys."
//
// This module provides pure-logic checks that run in CI (no browser needed):
//   1. Color contrast ratio (WCAG AA: 4.5:1 for normal text, 3:1 for large).
//   2. Required ARIA landmarks (header/nav/main/footer).
//   3. Form labels (every input has a label).
//   4. Alt text (every img has alt).
//   5. Heading hierarchy (no skipped levels: h1 → h3 is a violation).
//   6. Reduced-motion media query presence.

export type A11yViolationType =
  | "contrast"
  | "missing_landmark"
  | "missing_label"
  | "missing_alt"
  | "heading_hierarchy"
  | "missing_reduced_motion";

export interface A11yViolation {
  type: A11yViolationType;
  file?: string | undefined;
  line?: number | undefined;
  detail: string;
  severity: "error" | "warning";
}

// ───────────────────────────────────────────────
// 1. Color contrast ratio (WCAG)
// ───────────────────────────────────────────────

export function parseHexColor(hex: string): { r: number; g: number; b: number } | null {
  const cleaned = hex.replace("#", "");
  if (cleaned.length === 3) {
    const r = cleaned[0]!;
    const g = cleaned[1]!;
    const b = cleaned[2]!;
    return { r: parseInt(r + r, 16), g: parseInt(g + g, 16), b: parseInt(b + b, 16) };
  }
  if (cleaned.length === 6) {
    return {
      r: parseInt(cleaned.slice(0, 2), 16),
      g: parseInt(cleaned.slice(2, 4), 16),
      b: parseInt(cleaned.slice(4, 6), 16),
    };
  }
  return null;
}

export function relativeLuminance(r: number, g: number, b: number): number {
  function linearize(c: number): number {
    const cs = c / 255;
    return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
  }
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

export function contrastRatio(
  fg: { r: number; g: number; b: number },
  bg: { r: number; g: number; b: number },
): number {
  const fgL = relativeLuminance(fg.r, fg.g, fg.b);
  const bgL = relativeLuminance(bg.r, bg.g, bg.b);
  const lighter = Math.max(fgL, bgL);
  const darker = Math.min(fgL, bgL);
  return (lighter + 0.05) / (darker + 0.05);
}

export const WCAG_AA = {
  normalText: 4.5,
  largeText: 3.0,
  uiComponents: 3.0,
} as const;

export function meetsContrastAA(
  fg: { r: number; g: number; b: number },
  bg: { r: number; g: number; b: number },
  isLargeText: boolean = false,
): boolean {
  return contrastRatio(fg, bg) >= (isLargeText ? WCAG_AA.largeText : WCAG_AA.normalText);
}

// ───────────────────────────────────────────────
// 2. Required ARIA landmarks
// ───────────────────────────────────────────────

export const REQUIRED_LANDMARKS = ["header", "nav", "main", "footer"] as const;

export function checkLandmarks(html: string, file?: string): A11yViolation[] {
  const violations: A11yViolation[] = [];
  for (const landmark of REQUIRED_LANDMARKS) {
    const hasElement = new RegExp(`<${landmark}[\\s>]`, "i").test(html);
    const hasRole = new RegExp(`role=["']${landmark}["']`, "i").test(html);
    if (!hasElement && !hasRole) {
      violations.push({
        type: "missing_landmark",
        file,
        detail: `Missing ARIA landmark: <${landmark}> (or role="${landmark}")`,
        severity: "warning",
      });
    }
  }
  return violations;
}

// ───────────────────────────────────────────────
// 3. Form labels
// ───────────────────────────────────────────────

export function checkFormLabels(html: string, file?: string): A11yViolation[] {
  const violations: A11yViolation[] = [];
  const lines = html.split("\n");
  const inputPattern = /<input\s[^>]*>/gi;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    let match: RegExpExecArray | null;
    while ((match = inputPattern.exec(line)) !== null) {
      const input = match[0] ?? "";
      if (/aria-label\s*=/.test(input)) continue;
      if (/aria-labelledby\s*=/.test(input)) continue;
      if (/type\s*=\s*["']hidden["']/.test(input)) continue;
      const idMatch = input.match(/id\s*=\s*["']([^"']+)["']/);
      if (idMatch?.[1]) {
        const labelPattern = new RegExp(`<label[^>]*for\\s*=\\s*["']${idMatch[1]}["']`, "i");
        if (labelPattern.test(html)) continue;
      }
      violations.push({
        type: "missing_label",
        file,
        line: i + 1,
        detail: `Input without a label: ${input.slice(0, 80)}...`,
        severity: "error",
      });
    }
  }
  return violations;
}

// ───────────────────────────────────────────────
// 4. Alt text
// ───────────────────────────────────────────────

export function checkAltText(html: string, file?: string): A11yViolation[] {
  const violations: A11yViolation[] = [];
  const lines = html.split("\n");
  const imgPattern = /<img\s[^>]*>/gi;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    let match: RegExpExecArray | null;
    while ((match = imgPattern.exec(line)) !== null) {
      const img = match[0] ?? "";
      if (!/\balt\s*=/.test(img)) {
        violations.push({
          type: "missing_alt",
          file,
          line: i + 1,
          detail: `Image without alt text: ${img.slice(0, 80)}...`,
          severity: "error",
        });
      }
    }
  }
  return violations;
}

// ───────────────────────────────────────────────
// 5. Heading hierarchy
// ───────────────────────────────────────────────

export function checkHeadingHierarchy(html: string, file?: string): A11yViolation[] {
  const violations: A11yViolation[] = [];
  const headings: Array<{ level: number; line: number }> = [];
  const lines = html.split("\n");
  const headingPattern = /<h([1-6])\b/gi;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    let match: RegExpExecArray | null;
    while ((match = headingPattern.exec(line)) !== null) {
      headings.push({ level: parseInt(match[1] ?? "1", 10), line: i + 1 });
    }
  }
  let prevLevel = 0;
  for (const h of headings) {
    if (prevLevel > 0 && h.level > prevLevel + 1) {
      violations.push({
        type: "heading_hierarchy",
        file,
        line: h.line,
        detail: `Heading level skipped: h${prevLevel} → h${h.level} (should be h${prevLevel} → h${prevLevel + 1})`,
        severity: "warning",
      });
    }
    prevLevel = h.level;
  }
  return violations;
}

// ───────────────────────────────────────────────
// 6. Reduced-motion media query
// ───────────────────────────────────────────────

export function checkReducedMotion(source: string, file?: string): A11yViolation[] {
  if (!/prefers-reduced-motion/i.test(source)) {
    return [{
      type: "missing_reduced_motion",
      file,
      detail: "No @media (prefers-reduced-motion) found — animations should be disabled for users who prefer reduced motion",
      severity: "warning",
    }];
  }
  return [];
}

// ───────────────────────────────────────────────
// Run all checks (CI entry point)
// ───────────────────────────────────────────────

export interface A11yCheckOptions {
  files?: Array<{ path: string; content: string }>;
}

export function runA11yChecks(opts: A11yCheckOptions): A11yViolation[] {
  const violations: A11yViolation[] = [];
  if (opts.files) {
    for (const file of opts.files) {
      violations.push(...checkLandmarks(file.content, file.path));
      violations.push(...checkFormLabels(file.content, file.path));
      violations.push(...checkAltText(file.content, file.path));
      violations.push(...checkHeadingHierarchy(file.content, file.path));
      violations.push(...checkReducedMotion(file.content, file.path));
    }
  }
  return violations;
}
