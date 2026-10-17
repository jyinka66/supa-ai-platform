// Developer ecosystem governance — sandboxes, API keys, abuse detection, SDK releases.
// Section 3.4: "Every developer, sandbox, API key, and SDK release is governed."

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type AbuseLevel = "rate_limited" | "warning" | "suspended" | "banned";
export type SdkReleaseStatus = "signed" | "published" | "deprecated" | "yanked";

export interface SandboxGovernance {
  allowed: boolean;
  reason: string;
  limits: {
    rateLimitPerMin: number;
    monthlyBudgetUsd: number;
    maxTools: number;
    maxAgents: number;
    ttlHours: number;
  };
}

export interface ApiKeyGovernance {
  allowed: boolean;
  reason: string;
  scopes: string[];
  rateLimitPerMin: number;
  expiresAt: Date | null;
}

export interface AbuseDetection {
  level: AbuseLevel;
  reason: string;
  action: "throttle" | "warn" | "suspend" | "ban";
  evidence: string[];
}

export interface SdkReleaseGovernance {
  status: SdkReleaseStatus;
  signed: boolean;
  versionValid: boolean;
  deprecationPolicyApplied: boolean;
  reason: string;
}

// ───────────────────────────────────────────────
// Sandbox provisioning governance — automatic within limits.
// ───────────────────────────────────────────────

export function governSandboxProvisioning(input: {
  developerOrgId: string;
  existingSandboxes: number;
  orgReputation: number;
  orgVerified: boolean;
}): SandboxGovernance {
  const maxSandboxes = input.orgVerified ? 10 : 3;
  if (input.existingSandboxes >= maxSandboxes) {
    return {
      allowed: false,
      reason: `Sandbox limit reached: ${input.existingSandboxes}/${maxSandboxes}. ${input.orgVerified ? "Verified orgs" : "Unverified orgs"} may have up to ${maxSandboxes} sandboxes.`,
      limits: { rateLimitPerMin: 0, monthlyBudgetUsd: 0, maxTools: 0, maxAgents: 0, ttlHours: 0 },
    };
  }

  // Limits scale with reputation.
  const reputationBonus = Math.floor(input.orgReputation / 20); // 0-5 bonus.
  const limits = {
    rateLimitPerMin: 100 + reputationBonus * 20, // 100-200 req/min.
    monthlyBudgetUsd: 10 + reputationBonus * 5, // $10-$35.
    maxTools: 50 + reputationBonus * 10, // 50-100.
    maxAgents: 10 + reputationBonus * 2, // 10-20.
    ttlHours: 168, // 7 days (renewable).
  };

  return {
    allowed: true,
    reason: `Sandbox provisioned. Limits scaled by reputation (${input.orgReputation}): ${limits.rateLimitPerMin} req/min, $${limits.monthlyBudgetUsd} budget, ${limits.maxTools} tools, ${limits.maxAgents} agents, ${limits.ttlHours}h TTL.`,
    limits,
  };
}

// ───────────────────────────────────────────────
// API key issuance governance — automatic within limits, scoped.
// ───────────────────────────────────────────────

export function governApiKeyIssuance(input: {
  wsId: string;
  requestedScopes: string[];
  existingKeys: number;
  orgReputation: number;
}): ApiKeyGovernance {
  const maxKeys = 10;
  if (input.existingKeys >= maxKeys) {
    return {
      allowed: false,
      reason: `API key limit reached: ${input.existingKeys}/${maxKeys} per workspace.`,
      scopes: [],
      rateLimitPerMin: 0,
      expiresAt: null,
    };
  }

  // Reject excessive scopes.
  const excessiveScopes = ["admin", "root", "superuser", "*"];
  const filteredScopes = input.requestedScopes.filter((s) => !excessiveScopes.includes(s));

  // Rate limit scales with reputation.
  const rateLimit = input.orgReputation >= 70 ? 500 : 100;

  // Keys expire after 90 days (must be rotated).
  const expiresAt = new Date(Date.now() + 90 * 86400000);

  return {
    allowed: true,
    reason: `API key issued with ${filteredScopes.length} scopes. Rate limit: ${rateLimit} req/min. Expires in 90 days (rotation required).`,
    scopes: filteredScopes,
    rateLimitPerMin: rateLimit,
    expiresAt,
  };
}

// ───────────────────────────────────────────────
// Abuse detection — automated, escalating.
//
// Escalation: rate_limited → warning → suspended → banned.
// ───────────────────────────────────────────────

const ABUSE_THRESHOLDS = {
  rateLimitViolations: { warning: 5, suspend: 20, ban: 50 },
  budgetExceededCount: { warning: 2, suspend: 5, ban: 10 },
  spamReports: { warning: 3, suspend: 10, ban: 25 },
  securityIncidents: { suspend: 1, ban: 3 },
};

export function detectAbuse(input: {
  rateLimitViolations: number;
  budgetExceededCount: number;
  spamReports: number;
  securityIncidents: number;
}): AbuseDetection {
  const evidence: string[] = [];

  // Security incidents → immediate suspension or ban.
  if (input.securityIncidents >= ABUSE_THRESHOLDS.securityIncidents.ban) {
    evidence.push(`${input.securityIncidents} security incidents (≥ ${ABUSE_THRESHOLDS.securityIncidents.ban} → ban)`);
    return { level: "banned", reason: "Security incidents exceeded ban threshold", action: "ban", evidence };
  }
  if (input.securityIncidents >= ABUSE_THRESHOLDS.securityIncidents.suspend) {
    evidence.push(`${input.securityIncidents} security incidents (≥ ${ABUSE_THRESHOLDS.securityIncidents.suspend} → suspend)`);
    return { level: "suspended", reason: "Security incident detected", action: "suspend", evidence };
  }

  // Rate limit violations.
  if (input.rateLimitViolations >= ABUSE_THRESHOLDS.rateLimitViolations.ban) {
    evidence.push(`${input.rateLimitViolations} rate limit violations (≥ ${ABUSE_THRESHOLDS.rateLimitViolations.ban} → ban)`);
    return { level: "banned", reason: "Excessive rate limit violations", action: "ban", evidence };
  }
  if (input.rateLimitViolations >= ABUSE_THRESHOLDS.rateLimitViolations.suspend) {
    evidence.push(`${input.rateLimitViolations} rate limit violations (≥ ${ABUSE_THRESHOLDS.rateLimitViolations.suspend} → suspend)`);
    return { level: "suspended", reason: "Excessive rate limit violations", action: "suspend", evidence };
  }

  // Budget exceeded.
  if (input.budgetExceededCount >= ABUSE_THRESHOLDS.budgetExceededCount.ban) {
    evidence.push(`${input.budgetExceededCount} budget exceeded events (≥ ${ABUSE_THRESHOLDS.budgetExceededCount.ban} → ban)`);
    return { level: "banned", reason: "Excessive budget violations", action: "ban", evidence };
  }
  if (input.budgetExceededCount >= ABUSE_THRESHOLDS.budgetExceededCount.suspend) {
    evidence.push(`${input.budgetExceededCount} budget exceeded events (≥ ${ABUSE_THRESHOLDS.budgetExceededCount.suspend} → suspend)`);
    return { level: "suspended", reason: "Excessive budget violations", action: "suspend", evidence };
  }

  // Spam reports.
  if (input.spamReports >= ABUSE_THRESHOLDS.spamReports.ban) {
    evidence.push(`${input.spamReports} spam reports (≥ ${ABUSE_THRESHOLDS.spamReports.ban} → ban)`);
    return { level: "banned", reason: "Excessive spam reports", action: "ban", evidence };
  }
  if (input.spamReports >= ABUSE_THRESHOLDS.spamReports.suspend) {
    evidence.push(`${input.spamReports} spam reports (≥ ${ABUSE_THRESHOLDS.spamReports.suspend} → suspend)`);
    return { level: "suspended", reason: "Excessive spam reports", action: "suspend", evidence };
  }

  // Warnings.
  if (input.rateLimitViolations >= ABUSE_THRESHOLDS.rateLimitViolations.warning) {
    evidence.push(`${input.rateLimitViolations} rate limit violations (≥ ${ABUSE_THRESHOLDS.rateLimitViolations.warning} → warning)`);
    return { level: "warning", reason: "Rate limit violations approaching threshold", action: "warn", evidence };
  }
  if (input.budgetExceededCount >= ABUSE_THRESHOLDS.budgetExceededCount.warning) {
    evidence.push(`${input.budgetExceededCount} budget exceeded events (≥ ${ABUSE_THRESHOLDS.budgetExceededCount.warning} → warning)`);
    return { level: "warning", reason: "Budget exceeded multiple times", action: "warn", evidence };
  }
  if (input.spamReports >= ABUSE_THRESHOLDS.spamReports.warning) {
    evidence.push(`${input.spamReports} spam reports (≥ ${ABUSE_THRESHOLDS.spamReports.warning} → warning)`);
    return { level: "warning", reason: "Spam reports approaching threshold", action: "warn", evidence };
  }

  // Rate limited (minor, recoverable).
  if (input.rateLimitViolations > 0) {
    evidence.push(`${input.rateLimitViolations} rate limit violations`);
    return { level: "rate_limited", reason: "Rate limit violations detected", action: "throttle", evidence };
  }

  return { level: "rate_limited", reason: "No abuse detected", action: "throttle", evidence: [] };
}

// ───────────────────────────────────────────────
// SDK release governance — signed, versioned, deprecation.
// ───────────────────────────────────────────────

export function governSdkRelease(input: {
  version: string;
  isSigned: boolean;
  previousVersion: string;
  hasBreakingChanges: boolean;
  usageCount: number;
}): SdkReleaseGovernance {
  // Check version validity (semver).
  const versionValid = /^\d+\.\d+\.\d+$/.test(input.version);
  if (!versionValid) {
    return { status: "yanked", signed: input.isSigned, versionValid: false, deprecationPolicyApplied: false, reason: "Invalid version format (must be semver)." };
  }

  // Check signature.
  if (!input.isSigned) {
    return { status: "yanked", signed: false, versionValid: true, deprecationPolicyApplied: false, reason: "SDK release must be signed (npm provenance / sigstore)." };
  }

  // Check breaking changes require major bump.
  if (input.hasBreakingChanges) {
    const [prevMajor] = input.previousVersion.split(".").map(Number) as [number, number, number];
    const [newMajor] = input.version.split(".").map(Number) as [number, number, number];
    if (newMajor <= prevMajor) {
      return { status: "yanked", signed: true, versionValid: true, deprecationPolicyApplied: false, reason: `Breaking changes require major version bump (${input.previousVersion} → ${input.version}).` };
    }
  }

  // Deprecation policy: if this version supersedes the previous, mark the old one as deprecated.
  const deprecationPolicyApplied = input.version !== input.previousVersion;

  return {
    status: "published",
    signed: true,
    versionValid: true,
    deprecationPolicyApplied,
    reason: `SDK release ${input.version} published. Signed: yes. Version: valid. Previous ${input.previousVersion} deprecated.`,
  };
}
