/**
 * Supa OS Phase 4 — Enterprise, Marketplace, SDK & API Platform — tests.
 */

import { describe, it, expect } from "vitest";
import {
  DEPLOYMENT_MODELS,
  ENTERPRISE_TIERS,
  SSO_PROTOCOLS,
  ENTERPRISE_COMPLIANCE_EVIDENCE,
  getSlaForTier,
  initiateEnterpriseOnboarding,
  DEFAULT_AIR_GAP_CONFIG,
  verifyEnterpriseTier,
  type DeploymentModel,
  type EnterpriseTier,
  type SsoProtocol,
  type EnterpriseComplianceFramework,
} from "@/lib/supa-os/enterprise-tier";
import {
  MARKETPLACE_ITEM_TYPES,
  REVIEW_CHECKS,
  submitForReview,
  completeReview,
  discoverItems,
  calculateCreatorRevenue,
  verifyMarketplace,
  type MarketplaceItemType,
  type MarketplaceItemStatus,
  type MonetizationModel,
  type DiscoverySort,
} from "@/lib/supa-os/marketplace";
import {
  API_ENDPOINTS,
  SDKS,
  createApiKey,
  getDeveloperPortalConfig,
  DEFAULT_RATE_LIMITS,
  verifySdkApiPlatform,
  type ApiCategory,
  type ApiScope,
  type SdkLanguage,
  type WebhookEvent,
} from "@/lib/supa-os/sdk-api-platform";

// ───────────────────────────────────────────────
// 1. Enterprise Tier & On-Premises
// ───────────────────────────────────────────────

describe("1 — Enterprise Tier & On-Premises", () => {
  it("has 4 deployment models", () => {
    expect(DEPLOYMENT_MODELS).toHaveLength(4);
    const ids = DEPLOYMENT_MODELS.map((m) => m.id);
    expect(ids).toContain("public_saas");
    expect(ids).toContain("dedicated_hosted");
    expect(ids).toContain("private_cloud");
    expect(ids).toContain("on_premises");
  });

  it("on_premises is air-gapped capable with no network egress", () => {
    const onPrem = DEPLOYMENT_MODELS.find((m) => m.id === "on_premises");
    expect(onPrem?.airGapCapable).toBe(true);
    expect(onPrem?.networkEgress).toBe("none");
    expect(onPrem?.dataResidency).toBe("customer_controlled");
  });

  it("has 5 enterprise tiers", () => {
    expect(ENTERPRISE_TIERS).toHaveLength(5);
    const ids = ENTERPRISE_TIERS.map((t) => t.id);
    expect(ids).toContain("free");
    expect(ids).toContain("pro");
    expect(ids).toContain("business");
    expect(ids).toContain("enterprise");
    expect(ids).toContain("enterprise_plus");
  });

  it("enterprise_plus supports all 4 deployment models", () => {
    const ep = ENTERPRISE_TIERS.find((t) => t.id === "enterprise_plus");
    expect(ep?.deploymentModels).toHaveLength(4);
    expect(ep?.supportLevel).toBe("24x7");
  });

  it("free tier only supports public_saas", () => {
    const free = ENTERPRISE_TIERS.find((t) => t.id === "free");
    expect(free?.deploymentModels).toEqual(["public_saas"]);
  });

  it("SSO is included for business+ tiers", () => {
    expect(ENTERPRISE_TIERS.find((t) => t.id === "business")?.ssoIncluded).toBe(true);
    expect(ENTERPRISE_TIERS.find((t) => t.id === "enterprise")?.ssoIncluded).toBe(true);
    expect(ENTERPRISE_TIERS.find((t) => t.id === "free")?.ssoIncluded).toBe(false);
  });

  it("has 4 SSO protocols", () => {
    expect(SSO_PROTOCOLS).toHaveLength(4);
    const ids = SSO_PROTOCOLS.map((p) => p.id);
    expect(ids).toContain("saml");
    expect(ids).toContain("oidc");
    expect(ids).toContain("ldap");
    expect(ids).toContain("active_directory");
  });

  it("SLA for enterprise_plus is 99.99% uptime with 1h RTO/RPO", () => {
    const sla = getSlaForTier("enterprise_plus");
    expect(sla?.uptimePercent).toBe(99.99);
    expect(sla?.rtoHours).toBe(1);
    expect(sla?.rpoHours).toBe(1);
    expect(sla?.supportChannels).toContain("24x7_hotline");
  });

  it("SLA for free tier is null (no SLA)", () => {
    expect(getSlaForTier("free")).toBeNull();
  });

  it("has 9 compliance frameworks", () => {
    expect(ENTERPRISE_COMPLIANCE_EVIDENCE).toHaveLength(9);
    const frameworks = ENTERPRISE_COMPLIANCE_EVIDENCE.map((e) => e.framework);
    expect(frameworks).toContain("soc2_type_2");
    expect(frameworks).toContain("iso_27001");
    expect(frameworks).toContain("pci_dss");
    expect(frameworks).toContain("hipaa");
    expect(frameworks).toContain("fedramp");
  });

  it("initiates enterprise onboarding with SSO + air-gap", () => {
    const onboarding = initiateEnterpriseOnboarding({
      companyName: "Acme Bank",
      tier: "enterprise_plus",
      deploymentModel: "on_premises",
      ssoProtocol: "saml",
      complianceFrameworks: ["soc2_type_2", "pci_dss"],
    });
    expect(onboarding.companyName).toBe("Acme Bank");
    expect(onboarding.tier).toBe("enterprise_plus");
    expect(onboarding.sso?.protocol).toBe("saml");
    expect(onboarding.sla?.uptimePercent).toBe(99.99);
    expect(onboarding.airGap?.enabled).toBe(true);
    expect(onboarding.airGap?.isolationLevel).toBe("fully_air_gapped");
    expect(onboarding.complianceFrameworks).toContain("pci_dss");
    expect(onboarding.status).toBe("initiated");
  });

  it("rejects tier/model mismatch (free tier + on_premises)", () => {
    expect(() => initiateEnterpriseOnboarding({
      companyName: "Test",
      tier: "free",
      deploymentModel: "on_premises",
    })).toThrow();
  });

  it("verifyEnterpriseTier reports all implemented", () => {
    const v = verifyEnterpriseTier();
    expect(v.totalDeploymentModels).toBe(4);
    expect(v.totalTiers).toBe(5);
    expect(v.totalSsoProtocols).toBe(4);
    expect(v.totalComplianceFrameworks).toBe(9);
    expect(v.allImplemented).toBe(true);
  });
});

// ───────────────────────────────────────────────
// 2. Supa OS Marketplace
// ───────────────────────────────────────────────

describe("2 — Supa OS Marketplace", () => {
  it("has 5 item types", () => {
    expect(MARKETPLACE_ITEM_TYPES).toHaveLength(5);
    const types = MARKETPLACE_ITEM_TYPES.map((t) => t.type);
    expect(types).toContain("agent_skill");
    expect(types).toContain("api_connector");
    expect(types).toContain("ui_component");
    expect(types).toContain("template");
    expect(types).toContain("theme");
  });

  it("all 5 item types are monetizable", () => {
    expect(MARKETPLACE_ITEM_TYPES.every((t) => t.monetizable)).toBe(true);
  });

  it("has 6 review checks", () => {
    expect(REVIEW_CHECKS).toHaveLength(6);
    const ids = REVIEW_CHECKS.map((c) => c.id);
    expect(ids).toContain("schema");
    expect(ids).toContain("security");
    expect(ids).toContain("permissions");
    expect(ids).toContain("budget");
    expect(ids).toContain("plagiarism");
    expect(ids).toContain("quality");
  });

  it("submitForReview sets status to in_review", () => {
    const item = {
      id: "1", name: "Test", type: "agent_skill" as MarketplaceItemType,
      description: "Test", creatorId: "c1", creatorName: "Creator",
      status: "draft" as MarketplaceItemStatus, monetization: "free" as MonetizationModel,
      price: 0, version: "1.0.0", tags: [], downloadCount: 0, rating: 0, reviewCount: 0,
      featured: false, verified: false, publishedAt: null, createdAt: new Date(), updatedAt: new Date(),
    };
    const { item: submitted, checks } = submitForReview(item);
    expect(submitted.status).toBe("in_review");
    expect(checks).toHaveLength(6);
    expect(checks[0]?.status).toBe("approved"); // automated.
    expect(checks[5]?.status).toBe("in_progress"); // human review.
  });

  it("completeReview approves → published", () => {
    const item = {
      id: "1", name: "Test", type: "agent_skill" as MarketplaceItemType,
      description: "Test", creatorId: "c1", creatorName: "Creator",
      status: "in_review" as MarketplaceItemStatus, monetization: "free" as MonetizationModel,
      price: 0, version: "1.0.0", tags: [], downloadCount: 0, rating: 0, reviewCount: 0,
      featured: false, verified: false, publishedAt: null, createdAt: new Date(), updatedAt: new Date(),
    };
    const result = completeReview({ item, checks: [], decision: "approve", reviewerId: "r1", notes: "Good" });
    expect(result.status).toBe("published");
    expect(result.publishedAt).not.toBeNull();
  });

  it("completeReview rejects → rejected", () => {
    const item = {
      id: "1", name: "Test", type: "agent_skill" as MarketplaceItemType,
      description: "Test", creatorId: "c1", creatorName: "Creator",
      status: "in_review" as MarketplaceItemStatus, monetization: "free" as MonetizationModel,
      price: 0, version: "1.0.0", tags: [], downloadCount: 0, rating: 0, reviewCount: 0,
      featured: false, verified: false, publishedAt: null, createdAt: new Date(), updatedAt: new Date(),
    };
    const result = completeReview({ item, checks: [], decision: "reject", reviewerId: "r1", notes: "Bad" });
    expect(result.status).toBe("rejected");
  });

  it("discoverItems filters + sorts", () => {
    const items = [
      { id: "1", name: "Stripe Connector", type: "api_connector" as MarketplaceItemType, description: "Stripe", creatorId: "c1", creatorName: "C1", status: "published" as MarketplaceItemStatus, monetization: "free" as MonetizationModel, price: 0, version: "1.0", tags: ["payments"], downloadCount: 100, rating: 4.5, reviewCount: 10, featured: true, verified: true, publishedAt: new Date(), createdAt: new Date(), updatedAt: new Date() },
      { id: "2", name: "Loan Calculator", type: "ui_component" as MarketplaceItemType, description: "Loan", creatorId: "c2", creatorName: "C2", status: "published" as MarketplaceItemStatus, monetization: "one_time" as MonetizationModel, price: 29, version: "1.0", tags: ["fintech"], downloadCount: 50, rating: 5.0, reviewCount: 5, featured: false, verified: true, publishedAt: new Date(), createdAt: new Date(), updatedAt: new Date() },
      { id: "3", name: "Dark Theme", type: "theme" as MarketplaceItemType, description: "Dark", creatorId: "c1", creatorName: "C1", status: "draft" as MarketplaceItemStatus, monetization: "free" as MonetizationModel, price: 0, version: "1.0", tags: [], downloadCount: 0, rating: 0, reviewCount: 0, featured: false, verified: false, publishedAt: null, createdAt: new Date(), updatedAt: new Date() },
    ];
    // Filter by type.
    const connectors = discoverItems(items, { type: "api_connector" });
    expect(connectors).toHaveLength(1);
    expect(connectors[0]?.name).toBe("Stripe Connector");
    // Sort by top_rated.
    const topRated = discoverItems(items, { sort: "top_rated" });
    expect(topRated[0]?.name).toBe("Loan Calculator"); // 5.0 > 4.5
    // Draft items excluded.
    expect(discoverItems(items, {})).toHaveLength(2); // only 2 published.
  });

  it("calculateCreatorRevenue — 70/30 revenue share for revenue_share model", () => {
    const items = [
      { id: "1", name: "Test", type: "agent_skill" as MarketplaceItemType, description: "", creatorId: "c1", creatorName: "C1", status: "published" as MarketplaceItemStatus, monetization: "revenue_share" as MonetizationModel, price: 100, version: "1.0", tags: [], downloadCount: 10, rating: 4.5, reviewCount: 1, featured: false, verified: false, publishedAt: new Date(), createdAt: new Date(), updatedAt: new Date() },
    ];
    const revenue = calculateCreatorRevenue({
      items,
      monthlySales: [{ itemId: "1", quantity: 10, price: 100, monetization: "revenue_share" }],
      creatorId: "c1",
    });
    expect(revenue.totalRevenue).toBe(700); // 70% of 1000.
    expect(revenue.platformShare).toBe(300); // 30%.
    expect(revenue.creatorShare).toBe(700);
    expect(revenue.itemCount).toBe(1);
    expect(revenue.totalDownloads).toBe(10);
  });

  it("verifyMarketplace reports all implemented", () => {
    const v = verifyMarketplace();
    expect(v.totalItemTypes).toBe(5);
    expect(v.totalReviewChecks).toBe(6);
    expect(v.allImplemented).toBe(true);
  });

  it("MarketplaceItemType covers 5 types", () => {
    const t: MarketplaceItemType[] = ["agent_skill", "api_connector", "ui_component", "template", "theme"];
    expect(t).toHaveLength(5);
  });

  it("MonetizationModel covers 5 models", () => {
    const m: MonetizationModel[] = ["free", "one_time", "subscription", "revenue_share", "freemium"];
    expect(m).toHaveLength(5);
  });
});

// ───────────────────────────────────────────────
// 3. SDK & API Developer Platform
// ───────────────────────────────────────────────

describe("3 — SDK & API Developer Platform", () => {
  it("has 16+ REST API endpoints across 7 categories", () => {
    expect(API_ENDPOINTS.length).toBeGreaterThanOrEqual(16);
    const categories = new Set(API_ENDPOINTS.map((e) => e.category));
    expect(categories.size).toBe(7);
    expect(categories.has("build")).toBe(true);
    expect(categories.has("deploy")).toBe(true);
    expect(categories.has("agents")).toBe(true);
    expect(categories.has("templates")).toBe(true);
    expect(categories.has("sandbox")).toBe(true);
    expect(categories.has("webhooks")).toBe(true);
    expect(categories.has("billing")).toBe(true);
  });

  it("all endpoints are implemented", () => {
    expect(API_ENDPOINTS.every((e) => e.implemented)).toBe(true);
  });

  it("create Build Session endpoint is free tier + 30 rpm", () => {
    const ep = API_ENDPOINTS.find((e) => e.path === "/v1/build-sessions" && e.method === "POST");
    expect(ep?.freeTier).toBe(true);
    expect(ep?.rateLimit).toBe(30);
    expect(ep?.requiredScopes).toContain("build:write");
  });

  it("deploy endpoint is NOT free tier (requires business+)", () => {
    const ep = API_ENDPOINTS.find((e) => e.path === "/v1/build-sessions/:id/deploy");
    expect(ep?.freeTier).toBe(false);
  });

  it("has 8 SDKs", () => {
    expect(SDKS).toHaveLength(8);
    const langs = SDKS.map((s) => s.language);
    expect(langs).toContain("typescript");
    expect(langs).toContain("python");
    expect(langs).toContain("go");
    expect(langs).toContain("dart");
    expect(langs).toContain("rust");
  });

  it("TypeScript SDK is official + type-safe + streaming", () => {
    const ts = SDKS.find((s) => s.language === "typescript");
    expect(ts?.official).toBe(true);
    expect(ts?.typeSafe).toBe(true);
    expect(ts?.streaming).toBe(true);
    expect(ts?.packageName).toBe("@supa/os-sdk");
  });

  it("createApiKey generates a scoped key with prefix", () => {
    const { apiKey, config } = createApiKey({
      name: "My App Key",
      scopes: ["build:read", "build:write", "deploy:read"],
    });
    expect(apiKey).toContain("supa_os_");
    expect(config.name).toBe("My App Key");
    expect(config.scopes).toContain("build:write");
    expect(config.active).toBe(true);
    expect(config.keyPrefix).toContain("supa_os_");
  });

  it("developer portal config has API reference + playground + docs", () => {
    const portal = getDeveloperPortalConfig();
    expect(portal.apiReferenceUrl).toContain("api-reference");
    expect(portal.playgroundUrl).toContain("playground");
    expect(portal.docsUrl).toContain("docs.supa.ai");
    expect(Object.keys(portal.sdkUrls).length).toBe(8); // one per SDK language.
    expect(portal.playgroundRequiresAuth).toBe(true);
  });

  it("enterprise tier has unlimited rate limits", () => {
    expect(DEFAULT_RATE_LIMITS.tierOverrides.enterprise?.rpm).toBe(-1);
    expect(DEFAULT_RATE_LIMITS.tierOverrides.enterprise?.monthlyQuota).toBe(-1);
  });

  it("free tier has 30 rpm + 1000 monthly quota", () => {
    expect(DEFAULT_RATE_LIMITS.tierOverrides.free?.rpm).toBe(30);
    expect(DEFAULT_RATE_LIMITS.tierOverrides.free?.monthlyQuota).toBe(1000);
  });

  it("verifySdkApiPlatform reports all implemented", () => {
    const v = verifySdkApiPlatform();
    expect(v.totalEndpoints).toBeGreaterThanOrEqual(16);
    expect(v.totalSdks).toBe(8);
    expect(v.totalWebhookEvents).toBe(14);
    expect(v.totalApiScopes).toBe(13);
    expect(v.allImplemented).toBe(true);
  });

  it("ApiScope covers 13 scopes", () => {
    const s: ApiScope[] = [
      "build:read", "build:write", "deploy:read", "deploy:write",
      "agents:read", "agents:write", "templates:read", "templates:install",
      "sandbox:read", "sandbox:write", "webhooks:manage", "billing:read", "billing:write",
    ];
    expect(s).toHaveLength(13);
  });

  it("WebhookEvent covers 14 events", () => {
    const e: WebhookEvent[] = [
      "build.session.created", "build.session.completed", "build.session.failed",
      "agent.architect.completed", "agent.security.completed", "agent.fullstack.completed", "agent.qa.completed",
      "deploy.started", "deploy.healthy", "deploy.failed", "deploy.rolled_back",
      "sandbox.booted", "sandbox.stopped", "marketplace.item.installed",
    ];
    expect(e).toHaveLength(14);
  });

  it("SdkLanguage covers 8 languages", () => {
    const l: SdkLanguage[] = ["typescript", "python", "go", "dart", "rust", "ruby", "java", "php"];
    expect(l).toHaveLength(8);
  });
});

// ───────────────────────────────────────────────
// Phase 4 — overall verification
// ───────────────────────────────────────────────

describe("Phase 4 — overall verification", () => {
  it("all 3 Phase 4 modules are fully implemented", () => {
    expect(verifyEnterpriseTier().allImplemented).toBe(true);
    expect(verifyMarketplace().allImplemented).toBe(true);
    expect(verifySdkApiPlatform().allImplemented).toBe(true);
  });
});
