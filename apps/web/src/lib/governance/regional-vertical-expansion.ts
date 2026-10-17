// Regional + vertical expansion governance — threshold-based, compliance-gated.
// Section 3.5: "Every new region, language, and vertical is governed."

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type ExpansionKind = "region" | "language" | "vertical" | "jurisdiction";
export type ExpansionStatus = "eligible" | "threshold_met" | "compliance_gated" | "quality_gated" | "approved" | "blocked";

export interface ExpansionGovernance {
  kind: ExpansionKind;
  target: string;
  status: ExpansionStatus;
  thresholdMet: boolean;
  complianceVerified: boolean;
  qualityPassed: boolean;
  rollbackAllowed: boolean;
  reason: string;
}

// ───────────────────────────────────────────────
// Threshold-based activation.
// ───────────────────────────────────────────────

export const EXPANSION_THRESHOLDS: Record<ExpansionKind, number> = {
  region: 1000,       // 1000 users from this region.
  language: 500,       // 500 users with this locale.
  vertical: 100,       // 100 requests for this vertical.
  jurisdiction: 50,    // 50 enterprise users in this jurisdiction.
};

export function checkThreshold(kind: ExpansionKind, currentUsage: number): { met: boolean; threshold: number; remaining: number } {
  const threshold = EXPANSION_THRESHOLDS[kind];
  const met = currentUsage >= threshold;
  return { met, threshold, remaining: Math.max(0, threshold - currentUsage) };
}

// ───────────────────────────────────────────────
// Compliance gating — new jurisdictions require legal review.
// ───────────────────────────────────────────────

export interface ComplianceGate {
  legalDocsReady: boolean;
  policyConfigured: boolean;
  dataResidencyVerified: boolean;
  dpaSigned: boolean;       // Data Processing Agreement.
  baaSigned: boolean;       // Business Associate Agreement (HIPAA).
  customTermsVerified: boolean;
  passed: boolean;
  reason: string;
}

export function checkComplianceGate(input: {
  jurisdiction: string;
  legalDocsReady: boolean;
  policyConfigured: boolean;
  dataResidencyVerified: boolean;
  dpaSigned?: boolean;
  baaSigned?: boolean;
  customTermsVerified?: boolean;
}): ComplianceGate {
  const passed = input.legalDocsReady
    && input.policyConfigured
    && input.dataResidencyVerified
    && !(input.jurisdiction === "eu" && !input.dpaSigned)
    && !(input.jurisdiction === "us_healthcare" && !input.baaSigned)
    && input.customTermsVerified !== false;

  const reasons: string[] = [];
  if (!input.legalDocsReady) reasons.push("legal documents not ready");
  if (!input.policyConfigured) reasons.push("compliance policy not configured");
  if (!input.dataResidencyVerified) reasons.push("data residency not verified");
  if (input.jurisdiction === "eu" && !input.dpaSigned) reasons.push("DPA not signed (required for EU)");
  if (input.jurisdiction === "us_healthcare" && !input.baaSigned) reasons.push("BAA not signed (required for HIPAA)");
  if (input.customTermsVerified === false) reasons.push("custom terms not verified");

  return {
    legalDocsReady: input.legalDocsReady,
    policyConfigured: input.policyConfigured,
    dataResidencyVerified: input.dataResidencyVerified,
    dpaSigned: input.dpaSigned ?? false,
    baaSigned: input.baaSigned ?? false,
    customTermsVerified: input.customTermsVerified ?? true,
    passed,
    reason: passed ? "All compliance gates passed." : `Compliance gates failed: ${reasons.join(", ")}.`,
  };
}

// ───────────────────────────────────────────────
// Quality gating — new locales must pass QA + native review.
// ───────────────────────────────────────────────

export interface QualityGate {
  automatedQaPassed: boolean;
  nativeSpeakerReviewed: boolean;
  rtlCorrect: boolean;
  formattingCorrect: boolean;
  passed: boolean;
  reason: string;
}

export function checkQualityGate(input: {
  locale: string;
  automatedQaPassed: boolean;
  nativeSpeakerReviewed: boolean;
  rtlCorrect: boolean;
  formattingCorrect: boolean;
}): QualityGate {
  const passed = input.automatedQaPassed && input.nativeSpeakerReviewed && input.rtlCorrect && input.formattingCorrect;

  const reasons: string[] = [];
  if (!input.automatedQaPassed) reasons.push("automated QA not passed");
  if (!input.nativeSpeakerReviewed) reasons.push("native-speaker review not completed");
  if (!input.rtlCorrect) reasons.push("RTL issues detected");
  if (!input.formattingCorrect) reasons.push("formatting errors detected");

  return {
    ...input,
    passed,
    reason: passed ? "All quality gates passed." : `Quality gates failed: ${reasons.join(", ")}.`,
  };
}

// ───────────────────────────────────────────────
// Rollback policy — regional rollouts can be rolled back per region.
// ───────────────────────────────────────────────

export function canRollback(kind: ExpansionKind, target: string): { allowed: boolean; reason: string } {
  // Regions and languages can always be rolled back without affecting others.
  if (kind === "region" || kind === "language") {
    return { allowed: true, reason: `${kind} "${target}" can be rolled back without affecting other ${kind}s.` };
  }

  // Verticals can be rolled back (deactivated) without affecting other verticals.
  if (kind === "vertical") {
    return { allowed: true, reason: `Vertical "${target}" can be deactivated without affecting other verticals.` };
  }

  // Jurisdictions: rollback is more complex (legal implications).
  return { allowed: false, reason: `Jurisdiction "${target}" rollback requires legal review (irreversible implications).` };
}

// ───────────────────────────────────────────────
// governExpansion — the entry point for expansion governance.
// ───────────────────────────────────────────────

export function governExpansion(input: {
  kind: ExpansionKind;
  target: string;
  currentUsage: number;
  compliance?: ComplianceGate;
  quality?: QualityGate;
}): ExpansionGovernance {
  // 1. Check threshold.
  const thresholdCheck = checkThreshold(input.kind, input.currentUsage);
  if (!thresholdCheck.met) {
    return {
      kind: input.kind,
      target: input.target,
      status: "blocked",
      thresholdMet: false,
      complianceVerified: false,
      qualityPassed: false,
      rollbackAllowed: false,
      reason: `Threshold not met: ${input.currentUsage}/${thresholdCheck.threshold} users (${thresholdCheck.remaining} more needed).`,
    };
  }

  // 2. Check compliance (if applicable).
  const complianceVerified = input.compliance?.passed ?? true;
  if (!complianceVerified) {
    return {
      kind: input.kind,
      target: input.target,
      status: "compliance_gated",
      thresholdMet: true,
      complianceVerified: false,
      qualityPassed: false,
      rollbackAllowed: false,
      reason: input.compliance?.reason ?? "Compliance gates not passed.",
    };
  }

  // 3. Check quality (if applicable — languages/locales).
  const qualityPassed = input.quality?.passed ?? true;
  if (!qualityPassed) {
    return {
      kind: input.kind,
      target: input.target,
      status: "quality_gated",
      thresholdMet: true,
      complianceVerified: true,
      qualityPassed: false,
      rollbackAllowed: false,
      reason: input.quality?.reason ?? "Quality gates not passed.",
    };
  }

  // 4. Approved.
  const rollback = canRollback(input.kind, input.target);
  return {
    kind: input.kind,
    target: input.target,
    status: "approved",
    thresholdMet: true,
    complianceVerified: true,
    qualityPassed: true,
    rollbackAllowed: rollback.allowed,
    reason: `${input.kind} "${input.target}" approved. Threshold met, compliance verified, quality passed. Rollback: ${rollback.reason}`,
  };
}
