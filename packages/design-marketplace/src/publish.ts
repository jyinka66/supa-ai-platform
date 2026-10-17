/**
 * @supa/design-marketplace/publish
 * ----------------------------------------------------------------
 * Publishing runs the full automated gauntlet, all gates that exist
 * elsewhere in the system, pointed at one artifact.
 *
 * Versioning discipline: semver where
 *   MAJOR = any token removed or repurposed (a re-theme of an
 *           installed doc would change meaning)
 *   MINOR = token added or doc change (additive, non-breaking)
 *   PATCH = meta/description fix (no doc/tokens change)
 *
 * Human review is sampling-based on top (like the AI review queue):
 *   automated gates catch the measurable; a small review queue
 *   catches the "technically passes, visually broken" tail.
 * ----------------------------------------------------------------
 */

import type { TemplatePackage } from "./template-package.js";
import { walkTokenTable } from "./template-package.js";

// ───────────────────────────────────────────────
// Gate results
// ───────────────────────────────────────────────

export interface PublishGateResult {
  ok: boolean;
  /** Per-gate failures (empty if ok=true). */
  failures: GateFailure[];
  /** Review queue signal — true if the template needs human review. */
  needsHumanReview: boolean;
}

export interface GateFailure {
  gate: GateName;
  message: string;
  /** Per-item details (e.g. per-token violations). */
  details: { id: string; message: string }[];
}

export type GateName =
  | "tokens"
  | "a11y"
  | "perf"
  | "fonts"
  | "compat"
  | "provenance";

// ───────────────────────────────────────────────
// Gate interfaces (host provides impls; marketplace owns the gauntlet)
// ───────────────────────────────────────────────

export interface TokensGate {
  /** design-tokens gate: no literals in published templates. */
  check(pkg: TemplatePackage): GateFailure | null;
}

export interface A11yGate {
  /** contrast lint per variant, min hit sizes. */
  check(pkg: TemplatePackage): GateFailure | null;
}

export interface PerfGate {
  /**
   * Doc renders under budget at 800-layer-equivalent complexity on
   * the mid-tier profile — a bloated template is a perf regression
   * delivered to every installer.
   */
  check(pkg: TemplatePackage): GateFailure | null;
}

export interface FontsGate {
  /** license fields complete; embedding rules honored. */
  check(pkg: TemplatePackage): GateFailure | null;
}

export interface CompatGate {
  /** op-schema version checked. */
  check(pkg: TemplatePackage): GateFailure | null;
}

export interface ProvenanceGate {
  /** AI-assisted templates declared (provenance field surfaced on the listing). */
  check(pkg: TemplatePackage): GateFailure | null;
}

// ───────────────────────────────────────────────
// Publish gauntlet — runs all gates
// ───────────────────────────────────────────────

export interface PublishGauntletOptions {
  tokensGate: TokensGate;
  a11yGate: A11yGate;
  perfGate: PerfGate;
  fontsGate: FontsGate;
  compatGate: CompatGate;
  provenanceGate: ProvenanceGate;
  /** Sampling rate for human review (default 0.05 — 5% of passes go to review). */
  reviewSamplingRate?: number;
  /** Override random (tests). */
  random?: () => number;
}

/**
 * Run the full automated gauntlet. Returns ok=true iff every gate
 * passes. Templates that pass automated gates may still be queued
 * for human review (sampling-based, like the AI review queue).
 */
export function runPublishGauntlet(
  pkg: TemplatePackage,
  opts: PublishGauntletOptions,
): PublishGateResult {
  const failures: GateFailure[] = [];
  const gates: { name: GateName; check: () => GateFailure | null }[] = [
    { name: "tokens", check: () => opts.tokensGate.check(pkg) },
    { name: "a11y", check: () => opts.a11yGate.check(pkg) },
    { name: "perf", check: () => opts.perfGate.check(pkg) },
    { name: "fonts", check: () => opts.fontsGate.check(pkg) },
    { name: "compat", check: () => opts.compatGate.check(pkg) },
    { name: "provenance", check: () => opts.provenanceGate.check(pkg) },
  ];
  for (const gate of gates) {
    const failure = gate.check();
    if (failure) failures.push(failure);
  }

  const random = opts.random ?? Math.random;
  const reviewRate = opts.reviewSamplingRate ?? 0.05;
  const needsHumanReview = failures.length === 0 && random() < reviewRate;

  return {
    ok: failures.length === 0,
    failures,
    needsHumanReview,
  };
}

// ───────────────────────────────────────────────
// Semver discipline
// ───────────────────────────────────────────────

export type SemverBump = "MAJOR" | "MINOR" | "PATCH";

/**
 * Compute the semver bump required by a template change.
 *
 *   MAJOR = any token removed or repurposed (a re-theme of an
 *           installed doc would change meaning)
 *   MINOR = token added or doc change (additive, non-breaking)
 *   PATCH = meta/description fix (no doc/tokens change)
 */
export function computeSemverBump(
  oldPkg: TemplatePackage,
  newPkg: TemplatePackage,
  diff: { tokenChanges: { added: string[]; removed: string[]; changed: string[] }; docChanges: unknown[] },
): SemverBump {
  // MAJOR: any token removed or changed.
  if (diff.tokenChanges.removed.length > 0 || diff.tokenChanges.changed.length > 0) {
    return "MAJOR";
  }
  // MINOR: token added or doc changed.
  if (diff.tokenChanges.added.length > 0 || diff.docChanges.length > 0) {
    return "MINOR";
  }
  // PATCH: meta/description only.
  // Check if meta changed (name/description/categories).
  const metaChanged =
    JSON.stringify(oldPkg.meta.name) !== JSON.stringify(newPkg.meta.name) ||
    JSON.stringify(oldPkg.meta.description) !== JSON.stringify(newPkg.meta.description) ||
    JSON.stringify(oldPkg.meta.categories) !== JSON.stringify(newPkg.meta.categories);
  return metaChanged ? "PATCH" : "PATCH"; // no change → PATCH by default
}

/** Apply a semver bump to a version string. */
export function bumpSemver(version: string, bump: SemverBump): string {
  const parts = version.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error(`invalid semver: ${version}`);
  }
  const [major, minor, patch] = parts;
  switch (bump) {
    case "MAJOR":
      return `${major! + 1}.0.0`;
    case "MINOR":
      return `${major!}.${minor! + 1}.0`;
    case "PATCH":
      return `${major!}.${minor!}.${patch! + 1}`;
  }
}

// ───────────────────────────────────────────────
// Reference gate impls (for tests + as documentation of the contract)
// ───────────────────────────────────────────────

/**
 * Reference impl of the tokens gate — uses design-tokens'
 * validateTemplateForPublish. The host wires the real impl.
 */
export class RefTokensGate implements TokensGate {
  constructor(
    private readonly validate: (pkg: TemplatePackage) => GateFailure | null,
  ) {}
  check(pkg: TemplatePackage): GateFailure | null {
    return this.validate(pkg);
  }
}

export class RefCompatGate implements CompatGate {
  constructor(
    private readonly currentOpSchemaVersion: number,
    private readonly currentAppVersion: string,
  ) {}
  check(pkg: TemplatePackage): GateFailure | null {
    if (pkg.compat.opSchemaVersion > this.currentOpSchemaVersion) {
      return {
        gate: "compat",
        message: `template requires op-schema v${pkg.compat.opSchemaVersion}, current is v${this.currentOpSchemaVersion}`,
        details: [],
      };
    }
    return null;
  }
}

export class RefProvenanceGate implements ProvenanceGate {
  check(pkg: TemplatePackage): GateFailure | null {
    // AI-assisted templates must declare it (the meta.aiAssisted
    // field). Honesty as a product feature — surfaced on the listing.
    //
    // The check inspects the template's token provenance: if any
    // token carries an AI-assistance marker but the package meta
    // doesn't declare aiAssisted, the gate fails (undeclared AI
    // assistance is a listing-honesty violation). Declared-AI
    // templates pass; non-AI templates with no AI-provenance markers
    // also pass.
    if (pkg.meta.aiAssisted) {
      // Declared honestly — the listing will surface "AI-assisted".
      return null;
    }
    const aiTokens = findAiProvenanceTokens(pkg.tokens);
    if (aiTokens.length > 0) {
      return {
        gate: "provenance",
        message:
          `meta.aiAssisted is false but ${aiTokens.length} token(s) ` +
          `carry AI provenance — declare aiAssisted to surface it on the listing`,
        details: aiTokens.slice(0, 10).map((id) => ({
          id,
          message: "token has AI provenance but meta.aiAssisted is false",
        })),
      };
    }
    return null;
  }
}

/**
 * Walk the opaque token table looking for tokens whose definition
 * carries an AI-provenance marker. Accepts several common field
 * shapes (`provenance.aiAssisted: true`, `provenance.source: "ai"`,
 * `provenance.generator: "ai"`, `provenance.origin: "ai"`) since
 * different token-table schemas use different names for the same
 * concept.
 *
 * Returns the ids of tokens with AI provenance — empty when the
 * token table is empty / non-object / has no AI markers.
 */
function findAiProvenanceTokens(tokens: unknown): string[] {
  const found: string[] = [];
  walkTokenTable(tokens, (id, def) => {
    if (hasAiProvenance(def)) found.push(id);
  });
  return found;
}

function hasAiProvenance(def: unknown): boolean {
  if (!def || typeof def !== "object") return false;
  const provenance = (def as { provenance?: unknown }).provenance;
  if (!provenance || typeof provenance !== "object") return false;
  const p = provenance as {
    aiAssisted?: unknown;
    source?: unknown;
    generator?: unknown;
    origin?: unknown;
  };
  return (
    p.aiAssisted === true ||
    p.source === "ai" ||
    p.generator === "ai" ||
    p.origin === "ai"
  );
}
