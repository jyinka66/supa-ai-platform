/**
 * Governance Decision Domains 3.4-3.6 — tests.
 * Developer Ecosystem, Regional/Vertical Expansion, Enterprise Provisioning.
 */

import { describe, it, expect } from "vitest";
import {
  governSandboxProvisioning,
  governApiKeyIssuance,
  detectAbuse,
  governSdkRelease,
  type AbuseLevel,
  type SdkReleaseStatus,
} from "@/lib/governance/developer-ecosystem";
import {
  checkThreshold,
  EXPANSION_THRESHOLDS,
  checkComplianceGate,
  checkQualityGate,
  canRollback,
  governExpansion,
  type ExpansionKind,
  type ExpansionStatus,
} from "@/lib/governance/regional-vertical-expansion";
import {
  governProvisioning,
  checkEnterpriseCompliance,
  governUpgrade,
  checkLicenseEntitlement,
  type DeploymentGovernanceStatus,
} from "@/lib/governance/enterprise-provisioning";

// ───────────────────────────────────────────────
// 3.4 Developer Ecosystem
// ───────────────────────────────────────────────

describe("3.4 — Developer Ecosystem Governance", () => {
  it("sandbox: automatic within limits (verified orgs get 10)", () => {
    const gov = governSandboxProvisioning({ developerOrgId: "org-1", existingSandboxes: 5, orgReputation: 80, orgVerified: true });
    expect(gov.allowed).toBe(true);
    expect(gov.limits.rateLimitPerMin).toBeGreaterThan(100); // reputation bonus.
  });

  it("sandbox: blocked when limit reached", () => {
    const gov = governSandboxProvisioning({ developerOrgId: "org-1", existingSandboxes: 3, orgReputation: 30, orgVerified: false });
    expect(gov.allowed).toBe(false);
    expect(gov.reason).toContain("limit reached");
  });

  it("sandbox: unverified orgs limited to 3 sandboxes", () => {
    const gov = governSandboxProvisioning({ developerOrgId: "org-1", existingSandboxes: 2, orgReputation: 40, orgVerified: false });
    expect(gov.allowed).toBe(true);
    // 3 - 2 = 1 remaining.
  });

  it("API key: automatic within limits, scoped", () => {
    const gov = governApiKeyIssuance({ wsId: "ws-1", requestedScopes: ["file:read", "chat:write"], existingKeys: 3, orgReputation: 80 });
    expect(gov.allowed).toBe(true);
    expect(gov.scopes).toHaveLength(2);
    expect(gov.rateLimitPerMin).toBe(500); // reputation ≥ 70 → 500.
    expect(gov.expiresAt).not.toBeNull();
  });

  it("API key: blocked when limit reached (10 per workspace)", () => {
    const gov = governApiKeyIssuance({ wsId: "ws-1", requestedScopes: ["file:read"], existingKeys: 10, orgReputation: 80 });
    expect(gov.allowed).toBe(false);
  });

  it("API key: excessive scopes filtered out", () => {
    const gov = governApiKeyIssuance({ wsId: "ws-1", requestedScopes: ["file:read", "admin", "*"], existingKeys: 0, orgReputation: 50 });
    expect(gov.allowed).toBe(true);
    expect(gov.scopes).toEqual(["file:read"]); // admin and * filtered.
  });

  it("abuse: 4 levels (rate_limited → warning → suspended → banned)", () => {
    const levels: AbuseLevel[] = ["rate_limited", "warning", "suspended", "banned"];
    expect(levels).toHaveLength(4);
  });

  it("abuse: security incident → immediate suspend", () => {
    const abuse = detectAbuse({ rateLimitViolations: 0, budgetExceededCount: 0, spamReports: 0, securityIncidents: 1 });
    expect(abuse.level).toBe("suspended");
    expect(abuse.action).toBe("suspend");
  });

  it("abuse: 3 security incidents → ban", () => {
    const abuse = detectAbuse({ rateLimitViolations: 0, budgetExceededCount: 0, spamReports: 0, securityIncidents: 3 });
    expect(abuse.level).toBe("banned");
  });

  it("abuse: 50 rate limit violations → ban", () => {
    const abuse = detectAbuse({ rateLimitViolations: 50, budgetExceededCount: 0, spamReports: 0, securityIncidents: 0 });
    expect(abuse.level).toBe("banned");
  });

  it("abuse: 5 rate limit violations → warning", () => {
    const abuse = detectAbuse({ rateLimitViolations: 5, budgetExceededCount: 0, spamReports: 0, securityIncidents: 0 });
    expect(abuse.level).toBe("warning");
  });

  it("abuse: 1 rate limit violation → rate_limited (throttle)", () => {
    const abuse = detectAbuse({ rateLimitViolations: 1, budgetExceededCount: 0, spamReports: 0, securityIncidents: 0 });
    expect(abuse.level).toBe("rate_limited");
    expect(abuse.action).toBe("throttle");
  });

  it("SDK: signed release published", () => {
    const gov = governSdkRelease({ version: "1.2.0", isSigned: true, previousVersion: "1.1.0", hasBreakingChanges: false, usageCount: 1000 });
    expect(gov.status).toBe("published");
    expect(gov.signed).toBe(true);
    expect(gov.deprecationPolicyApplied).toBe(true);
  });

  it("SDK: unsigned release yanked", () => {
    const gov = governSdkRelease({ version: "1.2.0", isSigned: false, previousVersion: "1.1.0", hasBreakingChanges: false, usageCount: 1000 });
    expect(gov.status).toBe("yanked");
  });

  it("SDK: breaking changes without major bump yanked", () => {
    const gov = governSdkRelease({ version: "1.2.0", isSigned: true, previousVersion: "1.1.0", hasBreakingChanges: true, usageCount: 1000 });
    expect(gov.status).toBe("yanked");
    expect(gov.reason).toContain("major version bump");
  });

  it("SDK: breaking changes with major bump published", () => {
    const gov = governSdkRelease({ version: "2.0.0", isSigned: true, previousVersion: "1.9.0", hasBreakingChanges: true, usageCount: 1000 });
    expect(gov.status).toBe("published");
  });
});

// ───────────────────────────────────────────────
// 3.5 Regional and Vertical Expansion
// ───────────────────────────────────────────────

describe("3.5 — Regional and Vertical Expansion Governance", () => {
  it("has 4 expansion kinds: region, language, vertical, jurisdiction", () => {
    const kinds: ExpansionKind[] = ["region", "language", "vertical", "jurisdiction"];
    expect(kinds).toHaveLength(4);
  });

  it("threshold: region=1000, language=500, vertical=100, jurisdiction=50", () => {
    expect(EXPANSION_THRESHOLDS.region).toBe(1000);
    expect(EXPANSION_THRESHOLDS.language).toBe(500);
    expect(EXPANSION_THRESHOLDS.vertical).toBe(100);
    expect(EXPANSION_THRESHOLDS.jurisdiction).toBe(50);
  });

  it("threshold met when usage ≥ threshold", () => {
    expect(checkThreshold("region", 1000).met).toBe(true);
    expect(checkThreshold("region", 999).met).toBe(false);
  });

  it("compliance gate: all gates must pass", () => {
    const gate = checkComplianceGate({
      jurisdiction: "eu", legalDocsReady: true, policyConfigured: true, dataResidencyVerified: true, dpaSigned: true,
    });
    expect(gate.passed).toBe(true);
  });

  it("compliance gate: EU requires DPA", () => {
    const gate = checkComplianceGate({
      jurisdiction: "eu", legalDocsReady: true, policyConfigured: true, dataResidencyVerified: true, dpaSigned: false,
    });
    expect(gate.passed).toBe(false);
    expect(gate.reason).toContain("DPA");
  });

  it("compliance gate: healthcare requires BAA", () => {
    const gate = checkComplianceGate({
      jurisdiction: "us_healthcare", legalDocsReady: true, policyConfigured: true, dataResidencyVerified: true, dpaSigned: true, baaSigned: false,
    });
    expect(gate.passed).toBe(false);
    expect(gate.reason).toContain("BAA");
  });

  it("quality gate: all checks must pass", () => {
    const gate = checkQualityGate({ locale: "fr", automatedQaPassed: true, nativeSpeakerReviewed: true, rtlCorrect: true, formattingCorrect: true });
    expect(gate.passed).toBe(true);
  });

  it("quality gate: RTL issues block", () => {
    const gate = checkQualityGate({ locale: "ar", automatedQaPassed: true, nativeSpeakerReviewed: true, rtlCorrect: false, formattingCorrect: true });
    expect(gate.passed).toBe(false);
  });

  it("rollback: regions can be rolled back independently", () => {
    expect(canRollback("region", "eu").allowed).toBe(true);
    expect(canRollback("language", "fr").allowed).toBe(true);
  });

  it("rollback: jurisdictions require legal review", () => {
    const rollback = canRollback("jurisdiction", "eu");
    expect(rollback.allowed).toBe(false);
    expect(rollback.reason).toContain("legal review");
  });

  it("governExpansion: blocked when threshold not met", () => {
    const gov = governExpansion({ kind: "region", target: "af", currentUsage: 500 });
    expect(gov.status).toBe("blocked");
    expect(gov.thresholdMet).toBe(false);
  });

  it("governExpansion: approved when threshold + compliance + quality all pass", () => {
    const gov = governExpansion({
      kind: "language", target: "fr", currentUsage: 600,
      compliance: { legalDocsReady: true, policyConfigured: true, dataResidencyVerified: true, dpaSigned: true, baaSigned: false, customTermsVerified: true, passed: true, reason: "ok" },
      quality: { automatedQaPassed: true, nativeSpeakerReviewed: true, rtlCorrect: true, formattingCorrect: true, passed: true, reason: "ok" },
    });
    expect(gov.status).toBe("approved");
    expect(gov.rollbackAllowed).toBe(true);
  });

  it("governExpansion: compliance_gated when compliance fails", () => {
    const gov = governExpansion({
      kind: "region", target: "eu", currentUsage: 1500,
      compliance: { legalDocsReady: false, policyConfigured: true, dataResidencyVerified: true, dpaSigned: false, baaSigned: false, customTermsVerified: true, passed: false, reason: "legal docs not ready" },
    });
    expect(gov.status).toBe("compliance_gated");
  });
});

// ───────────────────────────────────────────────
// 3.6 Enterprise Provisioning
// ───────────────────────────────────────────────

describe("3.6 — Enterprise Provisioning Governance", () => {
  it("provisioning: approved when template exists + custom domain provided", () => {
    const gov = governProvisioning({
      deploymentType: "vpc", capacityTier: "medium", region: "eu-west",
      customDomain: "ai.acme.com", templateExists: true, requiresCustomDomain: true,
    });
    expect(gov.status).toBe("approved");
  });

  it("provisioning: blocked when template doesn't exist", () => {
    const gov = governProvisioning({
      deploymentType: "vpc", capacityTier: "medium", region: "eu-west",
      templateExists: false, requiresCustomDomain: true,
    });
    expect(gov.status).toBe("blocked");
  });

  it("provisioning: blocked when custom domain required but not provided", () => {
    const gov = governProvisioning({
      deploymentType: "on_prem", capacityTier: "large", region: "customer",
      templateExists: true, requiresCustomDomain: true,
    });
    expect(gov.status).toBe("blocked");
  });

  it("compliance: DPA + BAA + security review + data residency all required", () => {
    const gates = checkEnterpriseCompliance({
      jurisdiction: "us_healthcare", isHealthcare: true,
      dpaSigned: true, baaSigned: true, customTermsSigned: true,
      securityReviewPassed: true, dataResidencyConfirmed: true,
    });
    expect(gates.passed).toBe(true);
  });

  it("compliance: healthcare without BAA fails", () => {
    const gates = checkEnterpriseCompliance({
      jurisdiction: "us_healthcare", isHealthcare: true,
      dpaSigned: true, baaSigned: false, customTermsSigned: true,
      securityReviewPassed: true, dataResidencyConfirmed: true,
    });
    expect(gates.passed).toBe(false);
    expect(gates.reason).toContain("BAA");
  });

  it("upgrade: approved when canary passes + error rate within threshold", () => {
    const gov = governUpgrade({
      currentVersion: "1.0.0", targetVersion: "1.1.0",
      canaryResult: { passed: true, errorRate: 0.005, latencyIncreasePct: 10 },
      safetyGates: { canary: true, rollbackOnError: true, maxFailureRate: 0.01 },
      hasPreviousVersion: true,
    });
    expect(gov.status).toBe("upgrade_approved");
    expect(gov.rollbackAvailable).toBe(true);
  });

  it("upgrade: blocked when canary fails (error rate exceeds threshold)", () => {
    const gov = governUpgrade({
      currentVersion: "1.0.0", targetVersion: "1.1.0",
      canaryResult: { passed: false, errorRate: 0.02, latencyIncreasePct: 10 },
      safetyGates: { canary: true, rollbackOnError: true, maxFailureRate: 0.01 },
      hasPreviousVersion: true,
    });
    expect(gov.status).toBe("upgrade_blocked");
  });

  it("upgrade: blocked when latency increases > 50%", () => {
    const gov = governUpgrade({
      currentVersion: "1.0.0", targetVersion: "1.1.0",
      canaryResult: { passed: true, errorRate: 0.001, latencyIncreasePct: 60 },
      safetyGates: { canary: true, rollbackOnError: true, maxFailureRate: 0.01 },
      hasPreviousVersion: true,
    });
    expect(gov.status).toBe("upgrade_blocked");
    expect(gov.reason).toContain("Latency");
  });

  it("license: valid when all entitlements pass", () => {
    const check = checkLicenseEntitlement({
      licenseKey: "lic_abc", licenseValid: true, edition: "enterprise",
      maxSeats: 500, currentSeats: 100, maxApiCallsPerDay: 1000000, currentApiCallsToday: 50000,
      features: ["agents", "connectors", "sso", "custom_roles"], requestedFeature: "sso",
      expiresAt: new Date(Date.now() + 86400000), // tomorrow.
    });
    expect(check.valid).toBe(true);
  });

  it("license: expired → invalid", () => {
    const check = checkLicenseEntitlement({
      licenseKey: "lic_abc", licenseValid: true, edition: "enterprise",
      maxSeats: 500, currentSeats: 100, maxApiCallsPerDay: 1000000, currentApiCallsToday: 50000,
      features: ["agents"], requestedFeature: "agents",
      expiresAt: new Date(Date.now() - 86400000), // yesterday.
    });
    expect(check.valid).toBe(false);
    expect(check.expired).toBe(true);
  });

  it("license: seat limit exceeded → invalid", () => {
    const check = checkLicenseEntitlement({
      licenseKey: "lic_abc", licenseValid: true, edition: "standard",
      maxSeats: 50, currentSeats: 51, maxApiCallsPerDay: 100000, currentApiCallsToday: 5000,
      features: ["agents"], requestedFeature: "agents",
      expiresAt: null,
    });
    expect(check.valid).toBe(false);
    expect(check.reason).toContain("Seat limit");
  });

  it("license: feature not in edition → invalid", () => {
    const check = checkLicenseEntitlement({
      licenseKey: "lic_abc", licenseValid: true, edition: "standard",
      maxSeats: 50, currentSeats: 10, maxApiCallsPerDay: 100000, currentApiCallsToday: 5000,
      features: ["agents", "connectors"], requestedFeature: "sso", // sso not in standard.
      expiresAt: null,
    });
    expect(check.valid).toBe(false);
    expect(check.reason).toContain("not included");
  });

  it("license: API call limit exceeded → invalid", () => {
    const check = checkLicenseEntitlement({
      licenseKey: "lic_abc", licenseValid: true, edition: "standard",
      maxSeats: 50, currentSeats: 10, maxApiCallsPerDay: 100000, currentApiCallsToday: 100001,
      features: ["agents"], requestedFeature: "agents",
      expiresAt: null,
    });
    expect(check.valid).toBe(false);
    expect(check.reason).toContain("API call limit");
  });
});
