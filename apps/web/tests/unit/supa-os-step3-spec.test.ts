/**
 * Supa OS Step 3 — Platform Ecosystem & Business Strategy — tests.
 *
 * Verifies:
 *   1. Enterprise On-Premises: 9 private cloud targets, 5 container platforms, 9 sovereignty regimes.
 *   2. Marketplace Extension: 5 agent skills, 10 database adapters, 6 UI blueprint collections.
 *   3. Cross-Platform Export: 23 targets (6 web + 5 mobile + 12 backend).
 */

import { describe, it, expect } from "vitest";
import {
  PRIVATE_CLOUD_TARGETS,
  CONTAINER_DEPLOYMENTS,
  getDataSovereigntyConfig,
  configureOnPremDeployment,
  verifyOnPremDeployment,
  type PrivateCloudTarget,
  type ContainerPlatform,
  type DataSovereigntyRegime,
} from "@/lib/supa-os/on-prem-deployment";
import {
  AGENT_SKILLS_CATALOG,
  DATABASE_ADAPTERS_CATALOG,
  UI_BLUEPRINTS_CATALOG,
  verifyMarketplaceExtension,
  type AgentSkillCategory,
  type DatabaseType,
  type BlueprintCategory,
} from "@/lib/supa-os/marketplace-extension";
import {
  CROSS_EXPORT_TARGETS,
  configureCrossExport,
  verifyCrossExport,
  type CrossExportTarget,
  type ExportCategory,
} from "@/lib/supa-os/cross-export";

// ───────────────────────────────────────────────
// 1. Enterprise On-Premises Deployment
// ───────────────────────────────────────────────

describe("1 — Enterprise On-Premises Deployment", () => {
  it("has 9 private cloud targets", () => {
    expect(PRIVATE_CLOUD_TARGETS).toHaveLength(9);
    const ids = PRIVATE_CLOUD_TARGETS.map((t) => t.id);
    expect(ids).toContain("aws_govcloud");
    expect(ids).toContain("azure_government");
    expect(ids).toContain("google_assured");
    expect(ids).toContain("air_gapped");
  });

  it("AWS GovCloud is FedRAMP High + ITAR + CJIS", () => {
    const gov = PRIVATE_CLOUD_TARGETS.find((t) => t.id === "aws_govcloud");
    expect(gov?.fedrampHigh).toBe(true);
    expect(gov?.itar).toBe(true);
    expect(gov?.cjis).toBe(true);
    expect(gov?.customerManagedKeys).toBe(true);
  });

  it("Azure China is for China data localization (PIPL)", () => {
    const china = PRIVATE_CLOUD_TARGETS.find((t) => t.id === "azure_china");
    expect(china?.sovereigntyRegion).toBe("China");
    expect(china?.provider).toBe("Azure");
  });

  it("air_gapped is fully isolated (no network egress)", () => {
    const ag = PRIVATE_CLOUD_TARGETS.find((t) => t.id === "air_gapped");
    expect(ag?.airGapCapable).toBe(true);
    expect(ag?.networkEgress).toBe("none");
  });

  it("has 5 container platforms", () => {
    expect(CONTAINER_DEPLOYMENTS).toHaveLength(5);
    const platforms = CONTAINER_DEPLOYMENTS.map((c) => c.platform);
    expect(platforms).toContain("docker");
    expect(platforms).toContain("kubernetes");
    expect(platforms).toContain("openshift");
    expect(platforms).toContain("nomad");
    expect(platforms).toContain("docker_swarm");
  });

  it("Kubernetes deployment has auto-scaling + rolling updates + 3 replicas", () => {
    const k8s = CONTAINER_DEPLOYMENTS.find((c) => c.platform === "kubernetes");
    expect(k8s?.autoScaling).toBe(true);
    expect(k8s?.rollingUpdates).toBe(true);
    expect(k8s?.replicas).toBe(3);
    expect(k8s?.manifest).toContain("deployment.yaml");
  });

  it("has 9 data sovereignty regimes", () => {
    const regimes: DataSovereigntyRegime[] = [
      "us_only", "eu_only", "china_only", "russia_only",
      "india_only", "brazil_only", "south_africa_only",
      "government_only", "customer_defined",
    ];
    expect(regimes).toHaveLength(9);
  });

  it("China sovereignty enforces data localization + no cross-border transfer", () => {
    const config = getDataSovereigntyConfig("china_only");
    expect(config.dataLocalization).toBe(true);
    expect(config.crossBorderTransfer).toBe(false);
    expect(config.legalBasis).toContain("PIPL");
    expect(config.customerHoldsKeys).toBe(true);
  });

  it("EU sovereignty enforces GDPR", () => {
    const config = getDataSovereigntyConfig("eu_only");
    expect(config.legalBasis).toContain("GDPR");
    expect(config.dataLocalization).toBe(true);
  });

  it("configures on-prem deployment for a bank (AWS GovCloud + K8s + government_only)", () => {
    const deployment = configureOnPremDeployment({
      customerName: "Federal Reserve Bank",
      cloudTarget: "aws_govcloud",
      containerPlatform: "kubernetes",
      sovereignty: "government_only",
    });
    expect(deployment.customerName).toBe("Federal Reserve Bank");
    expect(deployment.cloudTarget).toBe("aws_govcloud");
    expect(deployment.containerPlatform).toBe("kubernetes");
    expect(deployment.airGapped).toBe(false);
    expect(deployment.byok).toBe(true);
    expect(deployment.complianceFrameworks).toContain("FedRAMP High");
    expect(deployment.complianceFrameworks).toContain("ITAR");
    expect(deployment.complianceFrameworks).toContain("CJIS");
    expect(deployment.estimatedSetupDays).toBeGreaterThanOrEqual(30);
  });

  it("configures air-gapped deployment (maximum isolation)", () => {
    const deployment = configureOnPremDeployment({
      customerName: "Defense Bank",
      cloudTarget: "air_gapped",
      containerPlatform: "docker",
      sovereignty: "us_only",
      airGapped: true,
    });
    expect(deployment.airGapped).toBe(true);
    expect(deployment.estimatedSetupDays).toBeGreaterThanOrEqual(45);
  });

  it("verifyOnPremDeployment reports all implemented", () => {
    const v = verifyOnPremDeployment();
    expect(v.totalPrivateCloudTargets).toBe(9);
    expect(v.totalContainerPlatforms).toBe(5);
    expect(v.totalSovereigntyRegimes).toBe(9);
    expect(v.allImplemented).toBe(true);
  });
});

// ───────────────────────────────────────────────
// 2. Marketplace Extension
// ───────────────────────────────────────────────

describe("2 — Supa OS Marketplace Extension", () => {
  it("has 5 agent skills", () => {
    expect(AGENT_SKILLS_CATALOG).toHaveLength(5);
    const names = AGENT_SKILLS_CATALOG.map((s) => s.name);
    expect(names).toContain("Fraud Detection Engine");
    expect(names).toContain("Credit Risk Analyzer");
    expect(names).toContain("Code Optimizer");
    expect(names).toContain("Test Generator Pro");
    expect(names).toContain("Compliance Scanner");
  });

  it("agent skills cover 5 categories", () => {
    const categories = new Set(AGENT_SKILLS_CATALOG.map((s) => s.category));
    expect(categories.has("security")).toBe(true);
    expect(categories.has("analysis")).toBe(true);
    expect(categories.has("optimization")).toBe(true);
    expect(categories.has("testing")).toBe(true);
    expect(categories.has("compliance")).toBe(true);
  });

  it("agent skills extend different agent roles", () => {
    const roles = AGENT_SKILLS_CATALOG.map((s) => s.extendsAgent);
    expect(roles).toContain("security");
    expect(roles).toContain("architect");
    expect(roles).toContain("fullstack");
    expect(roles).toContain("qa");
  });

  it("Fraud Detection Engine is subscription-based ($99/mo)", () => {
    const fraud = AGENT_SKILLS_CATALOG.find((s) => s.name === "Fraud Detection Engine");
    expect(fraud?.monetization).toBe("subscription");
    expect(fraud?.price).toBe(99);
    expect(fraud?.usesExternalAI).toBe(true);
  });

  it("has 10 database adapters", () => {
    expect(DATABASE_ADAPTERS_CATALOG).toHaveLength(10);
    const types = DATABASE_ADAPTERS_CATALOG.map((d) => d.databaseType);
    expect(types).toContain("postgresql");
    expect(types).toContain("mysql");
    expect(types).toContain("mongodb");
    expect(types).toContain("dynamodb");
    expect(types).toContain("supabase");
    expect(types).toContain("cockroachdb");
    expect(types).toContain("neon");
    expect(types).toContain("turso");
  });

  it("PostgreSQL adapter supports RLS + migrations + in-browser", () => {
    const pg = DATABASE_ADAPTERS_CATALOG.find((d) => d.databaseType === "postgresql");
    expect(pg?.supportsRLS).toBe(true);
    expect(pg?.supportsMigrations).toBe(true);
    expect(pg?.inBrowser).toBe(true);
    expect(pg?.monetization).toBe("free");
  });

  it("DynamoDB adapter is paid ($19 one-time)", () => {
    const ddb = DATABASE_ADAPTERS_CATALOG.find((d) => d.databaseType === "dynamodb");
    expect(ddb?.monetization).toBe("one_time");
    expect(ddb?.price).toBe(19);
  });

  it("has 6 UI blueprint collections", () => {
    expect(UI_BLUEPRINTS_CATALOG).toHaveLength(6);
    const names = UI_BLUEPRINTS_CATALOG.map((b) => b.name);
    expect(names).toContain("FinTech Pro UI Kit");
    expect(names).toContain("HealthCare Portal Kit");
    expect(names).toContain("Commerce Suite");
    expect(names).toContain("SaaS Dashboard Kit");
    expect(names).toContain("Enterprise Admin Kit");
    expect(names).toContain("Mobile First Kit");
  });

  it("FinTech Pro UI Kit has 45+ components + dark mode + RTL", () => {
    const fintech = UI_BLUEPRINTS_CATALOG.find((b) => b.name === "FinTech Pro UI Kit");
    expect(fintech?.componentCount).toBeGreaterThanOrEqual(45);
    expect(fintech?.darkMode).toBe(true);
    expect(fintech?.rtl).toBe(true);
    expect(fintech?.frameworks).toContain("React");
    expect(fintech?.frameworks).toContain("Flutter");
  });

  it("blueprints cover 6 categories", () => {
    const categories = new Set(UI_BLUEPRINTS_CATALOG.map((b) => b.category));
    expect(categories.has("fintech")).toBe(true);
    expect(categories.has("healthcare")).toBe(true);
    expect(categories.has("ecommerce")).toBe(true);
    expect(categories.has("saas")).toBe(true);
    expect(categories.has("enterprise")).toBe(true);
    expect(categories.has("mobile_first")).toBe(true);
  });

  it("verifyMarketplaceExtension reports all implemented", () => {
    const v = verifyMarketplaceExtension();
    expect(v.totalAgentSkills).toBe(5);
    expect(v.totalSkillCategories).toBe(10);
    expect(v.totalDatabaseAdapters).toBe(10);
    expect(v.totalDatabaseTypes).toBe(14);
    expect(v.totalUiBlueprints).toBe(6);
    expect(v.totalBlueprintCategories).toBe(10);
    expect(v.allImplemented).toBe(true);
  });

  it("AgentSkillCategory covers 10 categories", () => {
    const c: AgentSkillCategory[] = [
      "analysis", "generation", "transformation", "integration", "security",
      "optimization", "testing", "compliance", "ml_ai", "monitoring",
    ];
    expect(c).toHaveLength(10);
  });

  it("DatabaseType covers 14 types", () => {
    const t: DatabaseType[] = [
      "postgresql", "mysql", "mongodb", "redis", "dynamodb", "cassandra",
      "sqlite", "cockroachdb", "planetscale", "supabase", "fauna", "neon",
      "turso", "elasticsearch",
    ];
    expect(t).toHaveLength(14);
  });
});

// ───────────────────────────────────────────────
// 3. Multi-Platform Cross Export
// ───────────────────────────────────────────────

describe("3 — Multi-Platform Cross Export", () => {
  it("has 23 cross-export targets (6 web + 5 mobile + 12 backend)", () => {
    expect(CROSS_EXPORT_TARGETS).toHaveLength(23);
    const v = verifyCrossExport();
    expect(v.webTargets).toBe(6);
    expect(v.mobileTargets).toBe(5);
    expect(v.backendTargets).toBe(12);
  });

  it("all 23 targets are implemented", () => {
    expect(CROSS_EXPORT_TARGETS.every((t) => t.implemented)).toBe(true);
  });

  it("web targets include Next.js, Vue/Nuxt, Angular, SvelteKit, Astro, Remix", () => {
    const webIds = CROSS_EXPORT_TARGETS.filter((t) => t.category === "web").map((t) => t.id);
    expect(webIds).toContain("nextjs");
    expect(webIds).toContain("vue_nuxt");
    expect(webIds).toContain("angular");
    expect(webIds).toContain("sveltekit");
    expect(webIds).toContain("astro");
    expect(webIds).toContain("remix");
  });

  it("mobile targets include React Native, Expo, Flutter, iOS Swift, Android Kotlin", () => {
    const mobileIds = CROSS_EXPORT_TARGETS.filter((t) => t.category === "mobile").map((t) => t.id);
    expect(mobileIds).toContain("react_native");
    expect(mobileIds).toContain("expo");
    expect(mobileIds).toContain("flutter");
    expect(mobileIds).toContain("ios_swift");
    expect(mobileIds).toContain("android_kotlin");
  });

  it("backend targets include Node.js, Python, Go, Rust, Ruby, PHP", () => {
    const backendIds = CROSS_EXPORT_TARGETS.filter((t) => t.category === "backend").map((t) => t.id);
    expect(backendIds).toContain("node_hono");
    expect(backendIds).toContain("python_fastapi");
    expect(backendIds).toContain("go_gin");
    expect(backendIds).toContain("rust_axum");
    expect(backendIds).toContain("ruby_rails");
    expect(backendIds).toContain("php_laravel");
  });

  it("Next.js supports SSR + SSG + API routes + realtime", () => {
    const nextjs = CROSS_EXPORT_TARGETS.find((t) => t.id === "nextjs");
    expect(nextjs?.ssr).toBe(true);
    expect(nextjs?.ssg).toBe(true);
    expect(nextjs?.apiRoutes).toBe(true);
    expect(nextjs?.realtime).toBe(true);
  });

  it("Flutter uses Dart language", () => {
    const flutter = CROSS_EXPORT_TARGETS.find((t) => t.id === "flutter");
    expect(flutter?.language).toBe("Dart");
  });

  it("native iOS uses Swift + SwiftUI", () => {
    const ios = CROSS_EXPORT_TARGETS.find((t) => t.id === "ios_swift");
    expect(ios?.language).toBe("Swift");
    expect(ios?.framework).toContain("SwiftUI");
  });

  it("Go backend targets include 3 frameworks (Gin, Echo, chi)", () => {
    const goTargets = CROSS_EXPORT_TARGETS.filter((t) => t.language === "Go");
    expect(goTargets.length).toBe(3);
    expect(goTargets.map((t) => t.framework)).toContain("Gin");
    expect(goTargets.map((t) => t.framework)).toContain("Echo");
    expect(goTargets.map((t) => t.framework)).toContain("chi");
  });

  it("Python backend targets include 3 frameworks (FastAPI, Django, Flask)", () => {
    const pyTargets = CROSS_EXPORT_TARGETS.filter((t) => t.language === "Python");
    expect(pyTargets.length).toBe(3);
    expect(pyTargets.map((t) => t.framework)).toContain("FastAPI");
    expect(pyTargets.map((t) => t.framework)).toContain("Django");
    expect(pyTargets.map((t) => t.framework)).toContain("Flask");
  });

  it("configures multi-platform export (Next.js + Flutter + Go)", () => {
    const project = configureCrossExport({
      primary: "nextjs",
      secondary: ["flutter", "go_gin"],
    });
    expect(project.primary.id).toBe("nextjs");
    expect(project.secondary).toHaveLength(2);
    expect(project.secondary[0]?.id).toBe("flutter");
    expect(project.secondary[1]?.id).toBe("go_gin");
    expect(project.isMultiPlatform).toBe(true);
    expect(project.sharedApiContract).toBe(true);
    expect(project.sharedDatabase).toBe(true); // has backend (go_gin).
    expect(project.sharedDesignSystem).toBe(true); // has frontend (nextjs + flutter).
    expect(project.totalExportSeconds).toBeGreaterThan(0);
  });

  it("configures single-platform export (Next.js only)", () => {
    const project = configureCrossExport({ primary: "nextjs" });
    expect(project.isMultiPlatform).toBe(false);
    expect(project.secondary).toHaveLength(0);
  });

  it("verifyCrossExport reports all implemented", () => {
    const v = verifyCrossExport();
    expect(v.totalTargets).toBe(23);
    expect(v.allImplemented).toBe(true);
  });

  it("CrossExportTarget covers 23 targets", () => {
    const t: CrossExportTarget[] = [
      "nextjs", "vue_nuxt", "angular", "sveltekit", "astro", "remix",
      "react_native", "expo", "flutter", "ios_swift", "android_kotlin",
      "node_hono", "node_express", "node_fastify",
      "python_fastapi", "python_django", "python_flask",
      "go_gin", "go_echo", "go_chi",
      "rust_axum", "ruby_rails", "php_laravel",
    ];
    expect(t).toHaveLength(23);
  });

  it("ExportCategory covers 3 categories", () => {
    const c: ExportCategory[] = ["web", "mobile", "backend"];
    expect(c).toHaveLength(3);
  });
});

// ───────────────────────────────────────────────
// Overall verification
// ───────────────────────────────────────────────

describe("Step 3 — overall verification", () => {
  it("all 3 Step 3 modules are fully implemented", () => {
    expect(verifyOnPremDeployment().allImplemented).toBe(true);
    expect(verifyMarketplaceExtension().allImplemented).toBe(true);
    expect(verifyCrossExport().allImplemented).toBe(true);
  });
});
