/**
 * Supa OS — Phase 1 Core Architecture — tests.
 *
 * Verifies all 7 modules:
 *   1. Kernel (prompt parsing + orchestration plan)
 *   2. Architect Agent (DB schemas + API contracts + ER models)
 *   3. Security Agent (RBAC + encryption + KYC + compliance)
 *   4. UI/UX Agent (design system + screens + components)
 *   5. Full-Stack Agent (file tree generation)
 *   6. QA Agent (tests + lint + compliance verification)
 *   7. Integration & Deploy (integrations + deployment + CI/CD)
 */

import { describe, it, expect, vi } from "vitest";

// Mock adminAudit (DB-dependent) — the kernel calls it but we don't need the DB for spec tests.
vi.mock("@/lib/admin/audit", () => ({
  adminAudit: vi.fn().mockResolvedValue(undefined),
}));
import {
  parseGoal,
  createOrchestrationPlan,
  supaOSKernel,
  verifyKernel,
  DOMAIN_KEYWORDS,
  COMPLIANCE_KEYWORDS,
  PLATFORM_KEYWORDS,
  type AppDomain,
  type ComplianceRequirement,
  type TargetPlatform,
  type DeploymentTarget,
  type AgentRole,
  type ParsedGoal,
  type OrchestrationPlan,
} from "@/lib/supa-os/kernel";
import {
  designArchitecture,
  verifyArchitectAgent,
  type EntitySpec,
  type ApiEndpointSpec,
  type SchemaDesign,
  type ApiContract,
  type ArchitectOutput,
} from "@/lib/supa-os/architect-agent";
import {
  injectSecurityLayers,
  verifySecurityAgent,
  ROLE_DEFINITIONS,
  type RoleSpec,
  type EncryptionConfig,
  type KycFlow,
  type SecurityOutput,
} from "@/lib/supa-os/security-agent";
import {
  designInterface,
  verifyUiUxAgent,
  type DesignSystem,
  type ScreenSpec,
  type ComponentSpec,
  type UiUxOutput,
} from "@/lib/supa-os/uiux-agent";
import {
  generateFullStack,
  verifyFullStackAgent,
  type CodeFileSpec,
  type FullStackOutput,
} from "@/lib/supa-os/fullstack-agent";
import {
  generateTests,
  verifyQaAgent,
  type TestSpec,
  type TestResult,
  type QaOutput,
} from "@/lib/supa-os/qa-agent";
import {
  configureIntegrationAndDeploy,
  verifyIntegrationDeploy,
  type IntegrationConfig,
  type DeploymentConfig,
  type IntegrationDeployOutput,
} from "@/lib/supa-os/integration-deploy";

// ───────────────────────────────────────────────
// 1. Kernel
// ───────────────────────────────────────────────

describe("1 — Supa OS Kernel", () => {
  it("parses a fintech prompt correctly", () => {
    const goal = parseGoal("Build me a fintech app with loan management, KYC, and Stripe payments for web and mobile.");
    expect(goal.domain).toBe("fintech");
    expect(goal.compliance).toContain("kyc_aml");
    expect(goal.integrations).toContain("stripe");
    expect(goal.platforms).toContain("web");
    expect(goal.platforms).toContain("mobile_cross");
    expect(goal.features).toContain("loan_management");
    expect(goal.features).toContain("payments");
    expect(goal.confidence).toBeGreaterThan(50);
    expect(goal.requiresMultiAgent).toBe(true);
  });

  it("parses a SaaS prompt correctly", () => {
    const goal = parseGoal("Build a multi-tenant SaaS platform with workspace management and subscription billing.");
    expect(goal.domain).toBe("saas");
    expect(goal.features).toContain("multi_tenant");
    expect(goal.features).toContain("payments");
    expect(goal.requiresMultiAgent).toBe(true);
  });

  it("parses a healthcare prompt with HIPAA compliance", () => {
    const goal = parseGoal("Build a healthcare app with patient records and HIPAA compliance.");
    expect(goal.domain).toBe("healthcare");
    expect(goal.compliance).toContain("hipaa");
    expect(goal.features).toContain("user_profiles");
  });

  it("parses an ecommerce prompt", () => {
    const goal = parseGoal("Build an ecommerce marketplace with product catalog, cart, checkout, and order management.");
    expect(goal.domain).toBe("ecommerce");
    expect(goal.features).toContain("shopping_cart");
    expect(goal.features).toContain("product_catalog");
    expect(goal.features).toContain("order_management");
  });

  it("creates an orchestration plan with 5 agents in order", () => {
    const goal = parseGoal("Build a fintech app with KYC.");
    const plan = createOrchestrationPlan(goal);
    expect(plan.tasks).toHaveLength(5);
    expect(plan.executionOrder).toEqual(["architect", "security", "uiux", "fullstack", "qa"]);
    expect(plan.tasks.every((t) => t.blocking)).toBe(true);
    expect(plan.estimatedMinutes).toBeGreaterThan(0);
    expect(plan.planId).toBeTruthy();
  });

  it("kernel returns a ready result for clear prompts", async () => {
    const result = await supaOSKernel({
      prompt: "Build a fintech app with loan management, KYC, and Stripe payments.",
      ownerId: "user-1",
      wsId: "ws-1",
    });
    expect(result.ready).toBe(true);
    expect(result.goal.domain).toBe("fintech");
    expect(result.plan.tasks).toHaveLength(5);
  });

  it("detects all 10 domains", () => {
    expect(Object.keys(DOMAIN_KEYWORDS)).toHaveLength(10);
  });

  it("detects all 10 compliance types", () => {
    expect(Object.keys(COMPLIANCE_KEYWORDS)).toHaveLength(10);
  });

  it("detects all 6 platform types", () => {
    expect(Object.keys(PLATFORM_KEYWORDS)).toHaveLength(6);
  });

  it("AppDomain is the union of 10 domains", () => {
    const d: AppDomain[] = [
      "fintech", "saas", "ecommerce", "healthcare", "education",
      "logistics", "real_estate", "social", "internal_tools", "custom",
    ];
    expect(d).toHaveLength(10);
  });

  it("AgentRole is the union of 5 roles", () => {
    const r: AgentRole[] = ["architect", "security", "uiux", "fullstack", "qa"];
    expect(r).toHaveLength(5);
  });

  it("verifyKernel reports all implemented", () => {
    const v = verifyKernel();
    expect(v.allImplemented).toBe(true);
    expect(v.totalAgentRoles).toBe(5);
    expect(v.totalDomains).toBe(10);
  });
});

// ───────────────────────────────────────────────
// 2. Architect Agent
// ───────────────────────────────────────────────

describe("2 — Architect Agent", () => {
  it("designs architecture for a fintech app", () => {
    const goal = parseGoal("Build a fintech app with loan management, KYC, and Stripe payments.");
    const output = designArchitecture(goal);
    expect(output.schema.entities.length).toBeGreaterThan(3);
    expect(output.schema.entities.some((e) => e.name === "users")).toBe(true);
    expect(output.schema.entities.some((e) => e.name === "transactions")).toBe(true);
    expect(output.schema.entities.some((e) => e.name === "loans")).toBe(true);
    expect(output.schema.entities.some((e) => e.name === "kyc_verifications")).toBe(true);
    expect(output.schema.entities.some((e) => e.name === "audit_logs")).toBe(true);
    expect(output.schema.relationships.length).toBeGreaterThan(0);
    expect(output.schema.migrationSql).toContain("CREATE TABLE");
    expect(output.schema.erDiagram).toContain("erDiagram");
    expect(output.apiContract.endpoints.length).toBeGreaterThan(0);
    expect(output.apiContract.openApiSpec).toContain("openapi");
    expect(output.designDecisions.length).toBeGreaterThan(0);
  });

  it("every entity has RLS policy + audit triggers", () => {
    const goal = parseGoal("Build a fintech app.");
    const output = designArchitecture(goal);
    for (const e of output.schema.entities) {
      expect(e.rlsPolicy).toBeTruthy();
      expect(typeof e.hasAuditTriggers).toBe("boolean");
    }
  });

  it("generates CRUD endpoints for each entity", () => {
    const goal = parseGoal("Build a fintech app with loan management.");
    const output = designArchitecture(goal);
    const loanEndpoints = output.apiContract.endpoints.filter((e) => e.path.includes("loans"));
    expect(loanEndpoints.length).toBeGreaterThanOrEqual(4); // GET list, GET single, POST, PATCH/DELETE
    expect(loanEndpoints.some((e) => e.method === "GET")).toBe(true);
    expect(loanEndpoints.some((e) => e.method === "POST")).toBe(true);
  });

  it("verifyArchitectAgent reports all implemented", () => {
    const v = verifyArchitectAgent();
    expect(v.allImplemented).toBe(true);
    expect(v.totalEntityTypes).toBe(16);
  });
});

// ───────────────────────────────────────────────
// 3. Security Agent
// ───────────────────────────────────────────────

describe("3 — Security & Compliance Agent", () => {
  it("injects security layers for a fintech app with KYC", () => {
    const goal = parseGoal("Build a fintech app with KYC, PCI-DSS compliance, and Stripe payments.");
    const archOutput = designArchitecture(goal);
    const security = injectSecurityLayers(goal, archOutput.schema.entities);
    expect(security.roles.length).toBeGreaterThanOrEqual(7);
    expect(security.encryption.atRest.algorithm).toBe("aes-256-gcm");
    expect(security.encryption.tokenization.enabled).toBe(true);
    expect(security.encryption.tokenization.provider).toBe("stripe");
    expect(security.kycFlow).not.toBeNull();
    expect(security.kycFlow?.steps.length).toBeGreaterThanOrEqual(3);
    expect(security.complianceChecklist.length).toBeGreaterThan(0);
    expect(security.schemaModifications.length).toBeGreaterThan(0);
  });

  it("has 7 built-in roles", () => {
    expect(ROLE_DEFINITIONS).toHaveLength(7);
    const roleNames = ROLE_DEFINITIONS.map((r) => r.name);
    expect(roleNames).toContain("super_admin");
    expect(roleNames).toContain("owner");
    expect(roleNames).toContain("admin");
    expect(roleNames).toContain("member");
    expect(roleNames).toContain("viewer");
    expect(roleNames).toContain("developer");
    expect(roleNames).toContain("auditor");
  });

  it("owner can manage users + billing + audit logs", () => {
    const owner = ROLE_DEFINITIONS.find((r) => r.name === "owner");
    expect(owner?.canManageUsers).toBe(true);
    expect(owner?.canDeleteData).toBe(true);
    expect(owner?.canAccessBilling).toBe(true);
    expect(owner?.canViewAuditLogs).toBe(true);
  });

  it("viewer cannot manage users or delete data", () => {
    const viewer = ROLE_DEFINITIONS.find((r) => r.name === "viewer");
    expect(viewer?.canManageUsers).toBe(false);
    expect(viewer?.canDeleteData).toBe(false);
    expect(viewer?.canAccessBilling).toBe(false);
  });

  it("generates compliance checklist for PCI-DSS", () => {
    const goal = parseGoal("Build a fintech app with PCI-DSS compliance and Stripe.");
    const archOutput = designArchitecture(goal);
    const security = injectSecurityLayers(goal, archOutput.schema.entities);
    const pciChecks = security.complianceChecklist.filter((c) => c.requirement === "pci_dss");
    expect(pciChecks.length).toBeGreaterThanOrEqual(4);
    expect(pciChecks.every((c) => c.status === "required")).toBe(true);
  });

  it("verifySecurityAgent reports all implemented", () => {
    const v = verifySecurityAgent();
    expect(v.allImplemented).toBe(true);
    expect(v.totalRoles).toBe(7);
  });
});

// ───────────────────────────────────────────────
// 4. UI/UX Agent
// ───────────────────────────────────────────────

describe("4 — UI/UX Agent", () => {
  it("designs interface for a fintech app", () => {
    const goal = parseGoal("Build a fintech app with loan management, KYC, and Stripe payments for web and mobile.");
    const archOutput = designArchitecture(goal);
    const security = injectSecurityLayers(goal, archOutput.schema.entities);
    const uiux = designInterface(goal, archOutput.apiContract.endpoints, security.roles);
    expect(uiux.designSystem.colors.primary).toBeTruthy();
    expect(uiux.screens.length).toBeGreaterThan(3);
    expect(uiux.components.length).toBeGreaterThan(5);
    expect(uiux.breakpoints.sm).toBeTruthy();
    expect(uiux.platformNotes.length).toBeGreaterThan(0);
  });

  it("generates auth screens for every app", () => {
    const goal = parseGoal("Build a simple SaaS app.");
    const archOutput = designArchitecture(goal);
    const security = injectSecurityLayers(goal, archOutput.schema.entities);
    const uiux = designInterface(goal, archOutput.apiContract.endpoints, security.roles);
    const authScreens = uiux.screens.filter((s) => s.category === "auth");
    expect(authScreens.length).toBeGreaterThanOrEqual(2);
    expect(authScreens.some((s) => s.name === "Login")).toBe(true);
    expect(authScreens.some((s) => s.name === "Signup")).toBe(true);
  });

  it("generates fintech-specific screens (transactions + loans)", () => {
    const goal = parseGoal("Build a fintech app with loan management.");
    const archOutput = designArchitecture(goal);
    const security = injectSecurityLayers(goal, archOutput.schema.entities);
    const uiux = designInterface(goal, archOutput.apiContract.endpoints, security.roles);
    expect(uiux.screens.some((s) => s.name === "Transactions")).toBe(true);
    expect(uiux.screens.some((s) => s.name === "Loans")).toBe(true);
    expect(uiux.screens.some((s) => s.name === "LoanDetail")).toBe(true);
  });

  it("generates admin panel when RBAC includes admin roles", () => {
    const goal = parseGoal("Build a SaaS app with multi-tenant workspace.");
    const archOutput = designArchitecture(goal);
    const security = injectSecurityLayers(goal, archOutput.schema.entities);
    const uiux = designInterface(goal, archOutput.apiContract.endpoints, security.roles);
    expect(uiux.screens.some((s) => s.category === "admin")).toBe(true);
  });

  it("generates domain-specific design system (fintech uses teal)", () => {
    const goal = parseGoal("Build a fintech app.");
    const archOutput = designArchitecture(goal);
    const security = injectSecurityLayers(goal, archOutput.schema.entities);
    const uiux = designInterface(goal, archOutput.apiContract.endpoints, security.roles);
    expect(uiux.designSystem.colors.primary).toBe("#0F766E"); // teal
  });

  it("verifyUiUxAgent reports all implemented", () => {
    const v = verifyUiUxAgent();
    expect(v.allImplemented).toBe(true);
  });
});

// ───────────────────────────────────────────────
// 5. Full-Stack Agent
// ───────────────────────────────────────────────

describe("5 — Full-Stack Engineer Agent", () => {
  it("generates file tree for a fintech app", () => {
    const goal = parseGoal("Build a fintech app with loan management, KYC, and Stripe payments for web and mobile.");
    const archOutput = designArchitecture(goal);
    const security = injectSecurityLayers(goal, archOutput.schema.entities);
    const uiux = designInterface(goal, archOutput.apiContract.endpoints, security.roles);
    const fullstack = generateFullStack(goal, archOutput.schema, archOutput.apiContract, security, uiux);
    expect(fullstack.files.length).toBeGreaterThan(10);
    expect(fullstack.backendFiles.length).toBeGreaterThan(0);
    expect(fullstack.webFiles.length).toBeGreaterThan(0);
    expect(fullstack.databaseFiles.length).toBeGreaterThan(0);
    expect(fullstack.configFiles.length).toBeGreaterThan(0);
    expect(fullstack.mobileFiles.length).toBeGreaterThan(0); // mobile platform
    expect(fullstack.estimatedLines).toBeGreaterThan(500);
    expect(fullstack.techStack.length).toBeGreaterThan(5);
  });

  it("generates mobile files (Flutter) when mobile_cross platform", () => {
    const goal = parseGoal("Build a fintech app for web and mobile (Flutter).");
    const archOutput = designArchitecture(goal);
    const security = injectSecurityLayers(goal, archOutput.schema.entities);
    const uiux = designInterface(goal, archOutput.apiContract.endpoints, security.roles);
    const fullstack = generateFullStack(goal, archOutput.schema, archOutput.apiContract, security, uiux);
    expect(fullstack.mobileFiles.some((f) => f.path.endsWith(".dart"))).toBe(true);
  });

  it("includes Stripe in tech stack when integration detected", () => {
    const goal = parseGoal("Build a fintech app with Stripe payments.");
    const archOutput = designArchitecture(goal);
    const security = injectSecurityLayers(goal, archOutput.schema.entities);
    const uiux = designInterface(goal, archOutput.apiContract.endpoints, security.roles);
    const fullstack = generateFullStack(goal, archOutput.schema, archOutput.apiContract, security, uiux);
    expect(fullstack.techStack.some((t) => t.includes("Stripe"))).toBe(true);
  });

  it("verifyFullStackAgent reports all implemented", () => {
    const v = verifyFullStackAgent();
    expect(v.allImplemented).toBe(true);
  });
});

// ───────────────────────────────────────────────
// 6. QA Agent
// ───────────────────────────────────────────────

describe("6 — QA & Test Agent", () => {
  it("generates tests for all API endpoints + services + components", () => {
    const goal = parseGoal("Build a fintech app with loan management and KYC.");
    const archOutput = designArchitecture(goal);
    const security = injectSecurityLayers(goal, archOutput.schema.entities);
    const uiux = designInterface(goal, archOutput.apiContract.endpoints, security.roles);
    const fullstack = generateFullStack(goal, archOutput.schema, archOutput.apiContract, security, uiux);
    const qa = generateTests(goal, archOutput.apiContract, security, fullstack);
    expect(qa.tests.length).toBeGreaterThan(10);
    expect(qa.tests.some((t) => t.type === "unit")).toBe(true);
    expect(qa.tests.some((t) => t.type === "integration")).toBe(true);
    expect(qa.tests.some((t) => t.type === "e2e")).toBe(true);
    expect(qa.tests.some((t) => t.type === "compliance")).toBe(true);
    expect(qa.totalTests).toBeGreaterThan(20);
    expect(qa.coverage).toBeGreaterThan(0);
  });

  it("generates compliance tests when compliance is required", () => {
    const goal = parseGoal("Build a fintech app with KYC and PCI-DSS compliance.");
    const archOutput = designArchitecture(goal);
    const security = injectSecurityLayers(goal, archOutput.schema.entities);
    const uiux = designInterface(goal, archOutput.apiContract.endpoints, security.roles);
    const fullstack = generateFullStack(goal, archOutput.schema, archOutput.apiContract, security, uiux);
    const qa = generateTests(goal, archOutput.apiContract, security, fullstack);
    const complianceTests = qa.tests.filter((t) => t.type === "compliance");
    expect(complianceTests.length).toBeGreaterThan(0);
    expect(complianceTests.every((t) => t.blocking)).toBe(true);
  });

  it("produces a verdict (pass/fail/conditional)", () => {
    const goal = parseGoal("Build a simple SaaS app.");
    const archOutput = designArchitecture(goal);
    const security = injectSecurityLayers(goal, archOutput.schema.entities);
    const uiux = designInterface(goal, archOutput.apiContract.endpoints, security.roles);
    const fullstack = generateFullStack(goal, archOutput.schema, archOutput.apiContract, security, uiux);
    const qa = generateTests(goal, archOutput.apiContract, security, fullstack);
    expect(["pass", "fail", "conditional"]).toContain(qa.verdict);
    expect(qa.verdictReason.length).toBeGreaterThan(0);
  });

  it("verifyQaAgent reports all implemented", () => {
    const v = verifyQaAgent();
    expect(v.allImplemented).toBe(true);
  });
});

// ───────────────────────────────────────────────
// 7. Integration & Deploy
// ───────────────────────────────────────────────

describe("7 — Integration & Deploy", () => {
  it("configures Stripe integration for fintech apps", () => {
    const goal = parseGoal("Build a fintech app with Stripe payments and KYC.");
    const archOutput = designArchitecture(goal);
    const security = injectSecurityLayers(goal, archOutput.schema.entities);
    const uiux = designInterface(goal, archOutput.apiContract.endpoints, security.roles);
    const fullstack = generateFullStack(goal, archOutput.schema, archOutput.apiContract, security, uiux);
    const qa = generateTests(goal, archOutput.apiContract, security, fullstack);
    const deploy = configureIntegrationAndDeploy(goal, fullstack, qa);
    expect(deploy.integrations.some((i) => i.provider === "stripe")).toBe(true);
    expect(deploy.integrations.some((i) => i.provider === "persona")).toBe(true); // KYC
    expect(deploy.deployments.length).toBeGreaterThan(0);
    expect(deploy.pipeline.stages.length).toBeGreaterThanOrEqual(5);
  });

  it("generates CI/CD pipeline with lint → test → compliance → build → deploy → verify", () => {
    const goal = parseGoal("Build a fintech app with PCI-DSS compliance.");
    const archOutput = designArchitecture(goal);
    const security = injectSecurityLayers(goal, archOutput.schema.entities);
    const uiux = designInterface(goal, archOutput.apiContract.endpoints, security.roles);
    const fullstack = generateFullStack(goal, archOutput.schema, archOutput.apiContract, security, uiux);
    const qa = generateTests(goal, archOutput.apiContract, security, fullstack);
    const deploy = configureIntegrationAndDeploy(goal, fullstack, qa);
    const stageNames = deploy.pipeline.stages.map((s) => s.name);
    expect(stageNames).toContain("lint");
    expect(stageNames).toContain("test");
    expect(stageNames).toContain("build");
    expect(stageNames).toContain("deploy");
    expect(stageNames).toContain("verify");
  });

  it("handles app store submission for mobile apps", () => {
    const goal = parseGoal("Build a fintech app for web and mobile with KYC.");
    const archOutput = designArchitecture(goal);
    const security = injectSecurityLayers(goal, archOutput.schema.entities);
    const uiux = designInterface(goal, archOutput.apiContract.endpoints, security.roles);
    const fullstack = generateFullStack(goal, archOutput.schema, archOutput.apiContract, security, uiux);
    const qa = generateTests(goal, archOutput.apiContract, security, fullstack);
    const deploy = configureIntegrationAndDeploy(goal, fullstack, qa);
    expect(deploy.appStoreSubmission).not.toBeNull();
    expect(deploy.appStoreSubmission?.ios).toBe(true);
    expect(deploy.appStoreSubmission?.android).toBe(true);
  });

  it("blocks deployment when QA verdict is fail", () => {
    const goal = parseGoal("Build a fintech app with KYC.");
    const archOutput = designArchitecture(goal);
    const security = injectSecurityLayers(goal, archOutput.schema.entities);
    const uiux = designInterface(goal, archOutput.apiContract.endpoints, security.roles);
    const fullstack = generateFullStack(goal, archOutput.schema, archOutput.apiContract, security, uiux);
    const qa = generateTests(goal, archOutput.apiContract, security, fullstack);
    // Manually set QA verdict to fail.
    const failedQa: QaOutput = { ...qa, verdict: "fail", verdictReason: "test failure" };
    const deploy = configureIntegrationAndDeploy(goal, fullstack, failedQa);
    expect(deploy.status).toBe("blocked");
  });

  it("verifyIntegrationDeploy reports all implemented", () => {
    const v = verifyIntegrationDeploy();
    expect(v.allImplemented).toBe(true);
  });
});

// ───────────────────────────────────────────────
// Full pipeline — end-to-end
// ───────────────────────────────────────────────

describe("Supa OS — full pipeline (end-to-end)", () => {
  it("runs the complete 5-agent orchestration for a fintech app", async () => {
    // 1. Kernel — parse the goal.
    const kernelResult = await supaOSKernel({
      prompt: "Build a fintech app with loan management, KYC verification, and Stripe payments. Users can register, create profiles, and receive payments.",
      ownerId: "user-1",
      wsId: "ws-1",
    });
    expect(kernelResult.ready).toBe(true);
    expect(kernelResult.goal.domain).toBe("fintech");
    expect(kernelResult.goal.compliance).toContain("kyc_aml");

    // 2. Architect — design the schema + API.
    const archOutput = designArchitecture(kernelResult.goal);
    expect(archOutput.schema.entities.length).toBeGreaterThan(3);

    // 3. Security — inject compliance.
    const security = injectSecurityLayers(kernelResult.goal, archOutput.schema.entities);
    expect(security.encryption.atRest.algorithm).toBe("aes-256-gcm");
    expect(security.kycFlow).not.toBeNull();

    // 4. UI/UX — design the interface.
    const uiux = designInterface(kernelResult.goal, archOutput.apiContract.endpoints, security.roles);
    expect(uiux.screens.length).toBeGreaterThan(3);

    // 5. Full-Stack — generate the file tree.
    const fullstack = generateFullStack(kernelResult.goal, archOutput.schema, archOutput.apiContract, security, uiux);
    expect(fullstack.files.length).toBeGreaterThan(10);

    // 6. QA — generate tests.
    const qa = generateTests(kernelResult.goal, archOutput.apiContract, security, fullstack);
    expect(qa.tests.length).toBeGreaterThan(5);

    // 7. Integration & Deploy — configure + deploy.
    const deploy = configureIntegrationAndDeploy(kernelResult.goal, fullstack, qa);
    expect(deploy.integrations.length).toBeGreaterThan(0);
    expect(deploy.pipeline.stages.length).toBeGreaterThanOrEqual(5);
  });

  it("all 7 modules are verified as implemented", () => {
    expect(verifyKernel().allImplemented).toBe(true);
    expect(verifyArchitectAgent().allImplemented).toBe(true);
    expect(verifySecurityAgent().allImplemented).toBe(true);
    expect(verifyUiUxAgent().allImplemented).toBe(true);
    expect(verifyFullStackAgent().allImplemented).toBe(true);
    expect(verifyQaAgent().allImplemented).toBe(true);
    expect(verifyIntegrationDeploy().allImplemented).toBe(true);
  });
});
