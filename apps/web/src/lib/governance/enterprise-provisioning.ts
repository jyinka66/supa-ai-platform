// Enterprise provisioning governance — templates, compliance, upgrades, licenses.
// Section 3.6: "Every VPC, on-prem, and dedicated capacity deployment is governed."

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type DeploymentGovernanceStatus = "approved" | "compliance_gated" | "blocked" | "upgrade_approved" | "upgrade_blocked";

export interface DeploymentProvisioningGovernance {
  status: DeploymentGovernanceStatus;
  templateValid: boolean;
  complianceGatesPassed: boolean;
  licenseValid: boolean;
  reason: string;
}

export interface UpgradeGovernance {
  status: "upgrade_approved" | "upgrade_blocked";
  canaryPassed: boolean;
  safetyGatesPassed: boolean;
  rollbackAvailable: boolean;
  reason: string;
}

export interface LicenseCheck {
  valid: boolean;
  edition: string;
  maxSeats: number;
  maxApiCallsPerDay: number;
  features: string[];
  expired: boolean;
  reason: string;
}

// ───────────────────────────────────────────────
// Automated provisioning from templates with customer parameters.
// ───────────────────────────────────────────────

export function governProvisioning(input: {
  deploymentType: "cloud" | "vpc" | "on_prem" | "dedicated";
  capacityTier: "small" | "medium" | "large" | "xl";
  region: string;
  customDomain?: string;
  templateExists: boolean;
  requiresCustomDomain: boolean;
}): DeploymentProvisioningGovernance {
  // Template must exist.
  if (!input.templateExists) {
    return { status: "blocked", templateValid: false, complianceGatesPassed: false, licenseValid: false, reason: "Provisioning template does not exist for this configuration." };
  }

  // Custom domain requirement.
  if (input.requiresCustomDomain && !input.customDomain) {
    return { status: "blocked", templateValid: true, complianceGatesPassed: false, licenseValid: false, reason: `${input.deploymentType} requires a custom domain.` };
  }

  return {
    status: "approved",
    templateValid: true,
    complianceGatesPassed: true,
    licenseValid: true,
    reason: `Provisioning approved: ${input.deploymentType}/${input.capacityTier} in ${input.region}.`,
  };
}

// ───────────────────────────────────────────────
// Compliance gating — DPA, BAA, custom terms verified before provisioning.
// ───────────────────────────────────────────────

export interface EnterpriseComplianceGates {
  dpaVerified: boolean;        // Data Processing Agreement.
  baaVerified: boolean;        // Business Associate Agreement (HIPAA).
  customTermsVerified: boolean;
  securityReviewPassed: boolean;
  dataResidencyConfirmed: boolean;
  passed: boolean;
  reason: string;
}

export function checkEnterpriseCompliance(input: {
  jurisdiction: string;
  isHealthcare: boolean;
  dpaSigned: boolean;
  baaSigned: boolean;
  customTermsSigned: boolean;
  securityReviewPassed: boolean;
  dataResidencyConfirmed: boolean;
}): EnterpriseComplianceGates {
  const gates: string[] = [];

  if (!input.dpaSigned) gates.push("DPA not signed");
  if (input.isHealthcare && !input.baaSigned) gates.push("BAA not signed (required for healthcare)");
  if (!input.customTermsSigned) gates.push("custom terms not signed");
  if (!input.securityReviewPassed) gates.push("security review not passed");
  if (!input.dataResidencyConfirmed) gates.push("data residency not confirmed");

  const passed = gates.length === 0;

  return {
    dpaVerified: input.dpaSigned,
    baaVerified: input.baaSigned,
    customTermsVerified: input.customTermsSigned,
    securityReviewPassed: input.securityReviewPassed,
    dataResidencyConfirmed: input.dataResidencyConfirmed,
    passed,
    reason: passed ? "All enterprise compliance gates passed." : `Compliance gates failed: ${gates.join(", ")}.`,
  };
}

// ───────────────────────────────────────────────
// Upgrade governance — rolling upgrades with safety gates + rollback.
// ───────────────────────────────────────────────

export function governUpgrade(input: {
  currentVersion: string;
  targetVersion: string;
  canaryResult: { passed: boolean; errorRate: number; latencyIncreasePct: number };
  safetyGates: { canary: boolean; rollbackOnError: boolean; maxFailureRate: number };
  hasPreviousVersion: boolean; // can we roll back?
}): UpgradeGovernance {
  const maxFailureRatePct = input.safetyGates.maxFailureRate * 100;

  // Check canary.
  if (input.safetyGates.canary && !input.canaryResult.passed) {
    return {
      status: "upgrade_blocked",
      canaryPassed: false,
      safetyGatesPassed: false,
      rollbackAvailable: input.hasPreviousVersion,
      reason: `Canary failed: error rate ${input.canaryResult.errorRate * 100}% > ${maxFailureRatePct}% threshold. ${input.hasPreviousVersion ? "Rollback available." : "No previous version to roll back to."}`,
    };
  }

  // Check error rate.
  if (input.canaryResult.errorRate > input.safetyGates.maxFailureRate) {
    return {
      status: "upgrade_blocked",
      canaryPassed: input.canaryResult.passed,
      safetyGatesPassed: false,
      rollbackAvailable: input.hasPreviousVersion,
      reason: `Error rate ${input.canaryResult.errorRate * 100}% exceeds ${maxFailureRatePct}% threshold.`,
    };
  }

  // Check latency increase.
  if (input.canaryResult.latencyIncreasePct > 50) {
    return {
      status: "upgrade_blocked",
      canaryPassed: input.canaryResult.passed,
      safetyGatesPassed: false,
      rollbackAvailable: input.hasPreviousVersion,
      reason: `Latency increased by ${input.canaryResult.latencyIncreasePct}% (> 50% threshold).`,
    };
  }

  return {
    status: "upgrade_approved",
    canaryPassed: true,
    safetyGatesPassed: true,
    rollbackAvailable: input.hasPreviousVersion,
    reason: `Upgrade approved: ${input.currentVersion} → ${input.targetVersion}. Canary passed (error rate ${input.canaryResult.errorRate * 100}%, latency +${input.canaryResult.latencyIncreasePct}%). Rollback ${input.hasPreviousVersion ? "available" : "not available (first deployment)"}.`,
  };
}

// ───────────────────────────────────────────────
// License enforcement — entitlement checks at runtime.
// ───────────────────────────────────────────────

export function checkLicenseEntitlement(input: {
  licenseKey: string;
  licenseValid: boolean;
  edition: "standard" | "enterprise" | "enterprise_plus";
  maxSeats: number;
  currentSeats: number;
  maxApiCallsPerDay: number;
  currentApiCallsToday: number;
  features: string[];
  requestedFeature: string;
  expiresAt: Date | null;
}): LicenseCheck {
  // Check license validity.
  if (!input.licenseValid) {
    return { valid: false, edition: input.edition, maxSeats: 0, maxApiCallsPerDay: 0, features: [], expired: false, reason: "License is not valid (revoked or never issued)." };
  }

  // Check expiry.
  const expired = input.expiresAt != null && input.expiresAt < new Date();
  if (expired) {
    return { valid: false, edition: input.edition, maxSeats: 0, maxApiCallsPerDay: 0, features: [], expired: true, reason: `License expired on ${input.expiresAt?.toISOString()}.` };
  }

  // Check seat count.
  if (input.currentSeats > input.maxSeats) {
    return { valid: false, edition: input.edition, maxSeats: input.maxSeats, maxApiCallsPerDay: input.maxApiCallsPerDay, features: input.features, expired: false, reason: `Seat limit exceeded: ${input.currentSeats}/${input.maxSeats}.` };
  }

  // Check API call limit.
  if (input.currentApiCallsToday > input.maxApiCallsPerDay) {
    return { valid: false, edition: input.edition, maxSeats: input.maxSeats, maxApiCallsPerDay: input.maxApiCallsPerDay, features: input.features, expired: false, reason: `Daily API call limit exceeded: ${input.currentApiCallsToday}/${input.maxApiCallsPerDay}.` };
  }

  // Check feature entitlement.
  if (!input.features.includes(input.requestedFeature)) {
    return { valid: false, edition: input.edition, maxSeats: input.maxSeats, maxApiCallsPerDay: input.maxApiCallsPerDay, features: input.features, expired: false, reason: `Feature "${input.requestedFeature}" not included in ${input.edition} edition.` };
  }

  return {
    valid: true,
    edition: input.edition,
    maxSeats: input.maxSeats,
    maxApiCallsPerDay: input.maxApiCallsPerDay,
    features: input.features,
    expired: false,
    reason: `License valid. Edition: ${input.edition}. Seats: ${input.currentSeats}/${input.maxSeats}. API: ${input.currentApiCallsToday}/${input.maxApiCallsPerDay}. Feature "${input.requestedFeature}" allowed.`,
  };
}
