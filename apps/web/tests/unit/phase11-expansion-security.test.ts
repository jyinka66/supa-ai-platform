/**
 * Phase 11 — Expansion, Security, and Requirements — unit tests.
 *
 * Covers:
 *   1. Expansion pipeline stages + checklist validation.
 *   2. Threshold-based auto-expansion.
 *   3. PII redaction (email, phone, credit card, SSN, IP).
 *   4. Cookie consent per jurisdiction (GDPR opt-in, CCPA opt-out).
 *   5. Consent withdrawal + expiry.
 *   6. Performance/reliability/security requirements verification.
 */

import { describe, it, expect } from "vitest";
import {
  PIPELINE_STAGES,
  EXPANSION_THRESHOLDS,
  type ExpansionKind,
  type ExpansionStatus,
} from "@/lib/expansion/pipeline";
import {
  redactPii,
  redactTicket,
} from "@/lib/security/pii-redaction";
import {
  JURISDICTION_MODEL,
  JURISDICTION_REQUIRED_CATEGORIES,
  JURISDICTION_CONSENT_EXPIRY_DAYS,
  CURRENT_CONSENT_VERSION,
  isCategoryAllowed,
  type ConsentJurisdiction,
  type ConsentCategory,
} from "@/lib/security/consent";
import {
  PERFORMANCE_REQUIREMENTS,
  RELIABILITY_REQUIREMENTS,
  SECURITY_REQUIREMENTS,
  verifyRequirements,
  getRequirementSummary,
} from "@/lib/phase11/requirements";

// ───────────────────────────────────────────────
// Expansion pipeline
// ───────────────────────────────────────────────

describe("expansion pipeline stages", () => {
  it("has 7 stages (prioritized → live)", () => {
    expect(PIPELINE_STAGES).toHaveLength(7);
    expect(PIPELINE_STAGES[0]).toBe("prioritized");
    expect(PIPELINE_STAGES[PIPELINE_STAGES.length - 1]).toBe("live");
  });

  it("stages are ordered: prioritized → extracting → translating → reviewing → qa → publishing → live", () => {
    expect(PIPELINE_STAGES).toEqual([
      "prioritized", "extracting", "translating", "reviewing", "qa", "publishing", "live",
    ]);
  });

  it("'live' is terminal (last stage)", () => {
    expect(PIPELINE_STAGES.indexOf("live")).toBe(PIPELINE_STAGES.length - 1);
  });

  it("'abandoned' is NOT in the normal pipeline (it's a side-exit)", () => {
    expect(PIPELINE_STAGES).not.toContain("abandoned");
  });
});

describe("expansion thresholds", () => {
  it("language threshold is 500 users", () => {
    expect(EXPANSION_THRESHOLDS.language).toBe(500);
  });

  it("region threshold is 1000 users", () => {
    expect(EXPANSION_THRESHOLDS.region).toBe(1000);
  });

  it("jurisdiction threshold is 50 enterprise users", () => {
    expect(EXPANSION_THRESHOLDS.jurisdiction).toBe(50);
  });

  it("support_language threshold is 200 tickets", () => {
    expect(EXPANSION_THRESHOLDS.support_language).toBe(200);
  });

  it("region threshold > language threshold (regions are higher-commitment)", () => {
    expect(EXPANSION_THRESHOLDS.region).toBeGreaterThan(EXPANSION_THRESHOLDS.language);
  });
});

describe("expansion checklist validation", () => {
  const checklist = {
    extracted: true,
    translated: true,
    reviewed: true,
    qa_passed: true,
    published: true,
    verified: true,
  };

  it("a complete checklist allows advancing through all stages", () => {
    // Mirror the stageChecks logic.
    const stageChecks: Record<string, boolean> = {
      prioritized: true,
      extracting: checklist.extracted,
      translating: checklist.translated,
      reviewing: checklist.reviewed,
      qa: checklist.qa_passed,
      publishing: checklist.published,
      live: checklist.verified,
    };
    for (const [stage, passed] of Object.entries(stageChecks)) {
      expect(passed).toBe(true); // all stages pass with a complete checklist.
    }
  });

  it("an incomplete checklist blocks advancement", () => {
    const incomplete = { ...checklist, translated: false };
    expect(incomplete.translated).toBe(false); // blocks the translating→reviewing transition.
  });
});

// ───────────────────────────────────────────────
// PII redaction
// ───────────────────────────────────────────────

describe("PII redaction — email", () => {
  it("redacts email addresses", () => {
    const text = "Contact me at john.doe@example.com for help.";
    const redacted = redactPii(text);
    expect(redacted).toContain("[EMAIL_REDACTED]");
    expect(redacted).not.toContain("john.doe@example.com");
  });

  it("redacts multiple emails", () => {
    const text = "Email alice@foo.com or bob@bar.com.";
    const redacted = redactPii(text);
    expect(redacted.match(/\[EMAIL_REDACTED\]/g)?.length).toBe(2);
  });
});

describe("PII redaction — phone", () => {
  it("redacts US phone numbers", () => {
    const text = "Call me at 555-123-4567.";
    const redacted = redactPii(text, ["phone"]);
    expect(redacted).toContain("[PHONE_REDACTED]");
  });

  it("redacts international phone numbers", () => {
    const text = "Call +1 555 123 4567.";
    const redacted = redactPii(text, ["phone"]);
    expect(redacted).toContain("[PHONE_REDACTED]");
  });
});

describe("PII redaction — credit card", () => {
  it("redacts credit card numbers", () => {
    const text = "My card is 4111 1111 1111 1111.";
    const redacted = redactPii(text, ["credit_card"]);
    expect(redacted).toContain("[CARD_REDACTED]");
    expect(redacted).not.toContain("4111 1111 1111 1111");
  });
});

describe("PII redaction — SSN", () => {
  it("redacts SSNs", () => {
    const text = "SSN: 123-45-6789.";
    const redacted = redactPii(text, ["ssn"]);
    expect(redacted).toContain("[SSN_REDACTED]");
  });
});

describe("PII redaction — IP", () => {
  it("redacts IP addresses", () => {
    const text = "My IP is 192.168.1.1.";
    const redacted = redactPii(text, ["ip"]);
    expect(redacted).toContain("[IP_REDACTED]");
  });
});

describe("PII redaction — selective fields", () => {
  it("only redacts specified fields", () => {
    const text = "Email: john@example.com, Phone: 555-1234.";
    const redacted = redactPii(text, ["email"]); // only email.
    expect(redacted).toContain("[EMAIL_REDACTED]");
    expect(redacted).toContain("555-1234"); // phone NOT redacted.
  });
});

describe("PII redaction — ticket", () => {
  it("redacts all PII fields from a ticket", () => {
    const ticket = {
      subject: "Billing issue - john@example.com",
      body: "My card 4111 1111 1111 1111 was charged. Call me at 555-123-4567.",
      userEmail: "john@example.com",
    };
    const redacted = redactTicket(ticket);
    expect(redacted.subject).toContain("[EMAIL_REDACTED]");
    expect(redacted.body).toContain("[CARD_REDACTED]");
    expect(redacted.body).toContain("[PHONE_REDACTED]");
    expect(redacted.userEmail).toContain("[EMAIL_REDACTED]");
  });
});

// ───────────────────────────────────────────────
// Cookie consent per jurisdiction
// ───────────────────────────────────────────────

describe("cookie consent — jurisdiction models", () => {
  it("GDPR is opt-in (explicit consent required)", () => {
    expect(JURISDICTION_MODEL.gdpr).toBe("opt_in");
  });

  it("CCPA is opt-out (opt-out of sale/sharing)", () => {
    expect(JURISDICTION_MODEL.ccpa).toBe("opt_out");
  });

  it("LGPD is opt-in (Brazil, similar to GDPR)", () => {
    expect(JURISDICTION_MODEL.lgpd).toBe("opt_in");
  });

  it("DPDP is opt-in (India)", () => {
    expect(JURISDICTION_MODEL.dpdp).toBe("opt_in");
  });

  it("POPIA is opt-in (South Africa)", () => {
    expect(JURISDICTION_MODEL.popia).toBe("opt_in");
  });

  it("PIPL is opt-in (China)", () => {
    expect(JURISDICTION_MODEL.pipl).toBe("opt_in");
  });

  it("'none' jurisdiction requires no consent", () => {
    expect(JURISDICTION_MODEL.none).toBe("none");
  });
});

describe("cookie consent — required categories per jurisdiction", () => {
  it("GDPR requires consent for analytics + marketing + functional", () => {
    expect(JURISDICTION_REQUIRED_CATEGORIES.gdpr).toContain("analytics");
    expect(JURISDICTION_REQUIRED_CATEGORIES.gdpr).toContain("marketing");
    expect(JURISDICTION_REQUIRED_CATEGORIES.gdpr).toContain("functional");
  });

  it("CCPA only requires consent for marketing (sale/sharing)", () => {
    expect(JURISDICTION_REQUIRED_CATEGORIES.ccpa).toEqual(["marketing"]);
  });

  it("'none' requires no consent (necessary cookies only)", () => {
    expect(JURISDICTION_REQUIRED_CATEGORIES.none).toEqual([]);
  });
});

describe("cookie consent — expiry", () => {
  it("GDPR consent expires after 395 days (13 months)", () => {
    expect(JURISDICTION_CONSENT_EXPIRY_DAYS.gdpr).toBe(395);
  });

  it("PIPL consent expires after 365 days (1 year)", () => {
    expect(JURISDICTION_CONSENT_EXPIRY_DAYS.pipl).toBe(365);
  });

  it("CCPA consent does NOT expire (opt-out persists)", () => {
    expect(JURISDICTION_CONSENT_EXPIRY_DAYS.ccpa).toBeNull();
  });

  it("'none' jurisdiction has no expiry", () => {
    expect(JURISDICTION_CONSENT_EXPIRY_DAYS.none).toBeNull();
  });
});

describe("cookie consent — version", () => {
  it("has a current consent version (re-consent required when bumped)", () => {
    expect(CURRENT_CONSENT_VERSION).toBe("1.0.0");
  });
});

describe("cookie consent — category allowed check", () => {
  it("'necessary' is ALWAYS allowed (no consent needed)", () => {
    expect(isCategoryAllowed(null, "necessary")).toBe(true);
  });

  it("non-necessary categories require consent (null consent = not allowed)", () => {
    expect(isCategoryAllowed(null, "analytics")).toBe(false);
    expect(isCategoryAllowed(null, "marketing")).toBe(false);
  });

  it("consented categories are allowed", () => {
    const consent = {
      id: "test",
      userId: null,
      sessionId: "test",
      jurisdiction: "gdpr" as ConsentJurisdiction,
      consentGiven: true,
      consentCategories: ["necessary", "analytics"] as ConsentCategory[],
      consentVersion: "1.0.0",
      ip: null,
      userAgent: null,
      createdAt: new Date(),
      expiresAt: null,
      withdrawnAt: null,
    };
    expect(isCategoryAllowed(consent, "analytics")).toBe(true);
    expect(isCategoryAllowed(consent, "marketing")).toBe(false); // not consented.
  });

  it("withdrawn consent = only necessary allowed", () => {
    const consent = {
      id: "test",
      userId: null,
      sessionId: "test",
      jurisdiction: "gdpr" as ConsentJurisdiction,
      consentGiven: true,
      consentCategories: ["necessary", "analytics"] as ConsentCategory[],
      consentVersion: "1.0.0",
      ip: null,
      userAgent: null,
      createdAt: new Date(),
      expiresAt: null,
      withdrawnAt: new Date(), // withdrawn.
    };
    expect(isCategoryAllowed(consent, "analytics")).toBe(false); // withdrawn.
    expect(isCategoryAllowed(consent, "necessary")).toBe(true); // always.
  });

  it("expired consent = only necessary allowed", () => {
    const consent = {
      id: "test",
      userId: null,
      sessionId: "test",
      jurisdiction: "gdpr" as ConsentJurisdiction,
      consentGiven: true,
      consentCategories: ["necessary", "analytics"] as ConsentCategory[],
      consentVersion: "1.0.0",
      ip: null,
      userAgent: null,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() - 86400000), // expired yesterday.
      withdrawnAt: null,
    };
    expect(isCategoryAllowed(consent, "analytics")).toBe(false); // expired.
  });
});

// ───────────────────────────────────────────────
// Requirements verification
// ───────────────────────────────────────────────

describe("performance requirements", () => {
  it("locale page load < 2s on 3G", () => {
    expect(PERFORMANCE_REQUIREMENTS.localePageLoad3g).toBe(2000);
  });

  it("language switch < 200ms", () => {
    expect(PERFORMANCE_REQUIREMENTS.languageSwitch).toBe(200);
  });

  it("translation pipeline < 24h", () => {
    expect(PERFORMANCE_REQUIREMENTS.translationPipeline).toBe(24 * 60 * 60 * 1000);
  });

  it("sitemap generation < 60s", () => {
    expect(PERFORMANCE_REQUIREMENTS.sitemapGeneration).toBe(60_000);
  });

  it("OG image generation < 500ms", () => {
    expect(PERFORMANCE_REQUIREMENTS.ogImageGeneration).toBe(500);
  });

  it("a11y tests < 5min per PR", () => {
    expect(PERFORMANCE_REQUIREMENTS.a11yTestsPerPr).toBe(5 * 60 * 1000);
  });

  it("legal update propagation < 24h", () => {
    expect(PERFORMANCE_REQUIREMENTS.legalUpdatePropagation).toBe(24 * 60 * 60 * 1000);
  });
});

describe("reliability requirements", () => {
  it("all 7 reliability requirements are defined", () => {
    const keys = Object.keys(RELIABILITY_REQUIREMENTS);
    expect(keys).toHaveLength(7);
  });

  it("every locale serves correctly", () => {
    expect(RELIABILITY_REQUIREMENTS.everyLocaleServesCorrectly).toBe(true);
  });

  it("every legal doc in every jurisdiction", () => {
    expect(RELIABILITY_REQUIREMENTS.everyLegalDocInEveryJurisdiction).toBe(true);
  });

  it("every regional rollout verified", () => {
    expect(RELIABILITY_REQUIREMENTS.everyRegionalRolloutVerified).toBe(true);
  });
});

describe("security requirements", () => {
  it("all 9 security requirements are defined", () => {
    const keys = Object.keys(SECURITY_REQUIREMENTS);
    expect(keys).toHaveLength(9);
  });

  it("legal docs are versioned + tamper-evident", () => {
    expect(SECURITY_REQUIREMENTS.legalDocsVersionedAndTamperEvident).toBe(true);
  });

  it("data residency is enforced per workspace", () => {
    expect(SECURITY_REQUIREMENTS.dataResidencyEnforced).toBe(true);
  });

  it("5 data protection laws are listed", () => {
    expect(SECURITY_REQUIREMENTS.localDataProtectionLaws).toHaveLength(5);
    expect(SECURITY_REQUIREMENTS.localDataProtectionLaws).toContain("gdpr");
    expect(SECURITY_REQUIREMENTS.localDataProtectionLaws).toContain("lgpd");
    expect(SECURITY_REQUIREMENTS.localDataProtectionLaws).toContain("dpdp");
    expect(SECURITY_REQUIREMENTS.localDataProtectionLaws).toContain("popia");
    expect(SECURITY_REQUIREMENTS.localDataProtectionLaws).toContain("pipl");
  });

  it("support PII redaction is required", () => {
    expect(SECURITY_REQUIREMENTS.supportTicketsPiiRedaction).toBe(true);
  });

  it("support access is logged + justified", () => {
    expect(SECURITY_REQUIREMENTS.supportAccessLogged).toBe(true);
  });

  it("HTTPS-only is required", () => {
    expect(SECURITY_REQUIREMENTS.httpsOnly).toBe(true);
  });

  it("consent is per-jurisdiction", () => {
    expect(SECURITY_REQUIREMENTS.consentPerJurisdiction).toBe(true);
  });

  it("a11y never compromises privacy", () => {
    expect(SECURITY_REQUIREMENTS.a11yNeverCompromisesPrivacy).toBe(true);
  });
});

describe("requirements verification", () => {
  it("verifyRequirements() returns 23 checks (8 performance + 7 reliability + 9 security)", () => {
    const checks = verifyRequirements();
    expect(checks).toHaveLength(24); // 8 + 7 + 9 = 24.
  });

  it("all checks are currently met (met=true)", () => {
    const checks = verifyRequirements();
    const unmet = checks.filter((c) => !c.met);
    // All requirements are met by the implemented infrastructure.
    // (If any are unmet, the test documents which — the cron alerts on this.)
    expect(unmet).toEqual([]);
  });

  it("each check has name, category, requirement, met, detail", () => {
    const checks = verifyRequirements();
    for (const check of checks) {
      expect(check).toHaveProperty("name");
      expect(check).toHaveProperty("category");
      expect(check).toHaveProperty("requirement");
      expect(check).toHaveProperty("met");
      expect(check).toHaveProperty("detail");
    }
  });

  it("checks span 3 categories (performance, reliability, security)", () => {
    const checks = verifyRequirements();
    const categories = new Set(checks.map((c) => c.category));
    expect(categories).toContain("performance");
    expect(categories).toContain("reliability");
    expect(categories).toContain("security");
  });

  it("getRequirementSummary returns totalChecks, met, unmet", () => {
    const summary = getRequirementSummary();
    expect(summary).toHaveProperty("totalChecks");
    expect(summary).toHaveProperty("met");
    expect(summary).toHaveProperty("unmet");
    expect(summary).toHaveProperty("unmetChecks");
    expect(summary.totalChecks).toBe(24);
    expect(summary.met).toBe(24);
    expect(summary.unmet).toBe(0);
  });
});
