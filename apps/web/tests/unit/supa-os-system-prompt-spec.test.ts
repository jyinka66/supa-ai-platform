/**
 * Supa OS — System Prompt Architecture + System 2 Reasoning + Core Pipeline — tests.
 */

import { describe, it, expect } from "vitest";
import {
  CORE_MISSION,
  REASONING_PHASES,
  OUTPUT_RULES,
  PROHIBITED_PATTERNS,
  COMPLIANCE_GATES,
  PIPELINE_STEPS,
  runSystem2Reasoning,
  buildMasterSystemPrompt,
  executePipeline,
  verifySystemPrompt,
  type ReasoningPhaseId,
  type ReasoningPhaseStatus,
  type OutputRuleCategory,
  type ComplianceGateId,
  type PipelineStepId,
} from "@/lib/supa-os/system-prompt";

// ───────────────────────────────────────────────
// 1. Core Mission
// ───────────────────────────────────────────────

describe("1 — Core Mission", () => {
  it("has identity + goal + target domains + quality standard + output contract", () => {
    expect(CORE_MISSION.identity).toBe("Supa AI OS");
    expect(CORE_MISSION.goal).toContain("production-grade");
    expect(CORE_MISSION.targetDomains.length).toBeGreaterThanOrEqual(5);
    expect(CORE_MISSION.qualityStandard).toContain("No placeholders");
    expect(CORE_MISSION.outputContract.length).toBeGreaterThanOrEqual(10);
  });

  it("output contract includes: no placeholders, strict TypeScript, Zod validation, RLS, encryption", () => {
    const contract = CORE_MISSION.outputContract.join(" ");
    expect(contract).toContain("Never place placeholders");
    expect(contract).toContain("TypeScript strict mode");
    expect(contract).toContain("Zod validation");
    expect(contract).toContain("RLS");
    expect(contract).toContain("AES-256-GCM");
  });

  it("target domains include fintech, banking, loan systems, SaaS", () => {
    const domains = CORE_MISSION.targetDomains.join(" ");
    expect(domains).toContain("Fintech");
    expect(domains).toContain("Banking");
    expect(domains).toContain("Loan");
    expect(domains).toContain("SaaS");
  });
});

// ───────────────────────────────────────────────
// 2. System 2 Reasoning
// ───────────────────────────────────────────────

describe("2 — System 2 Reasoning Engine", () => {
  it("has 4 reasoning phases", () => {
    expect(REASONING_PHASES).toHaveLength(4);
    const ids = REASONING_PHASES.map((p) => p.id);
    expect(ids).toContain("domain_boundaries");
    expect(ids).toContain("security_audit");
    expect(ids).toContain("component_topology");
    expect(ids).toContain("dependency_validation");
  });

  it("all 4 phases are blocking + implemented", () => {
    expect(REASONING_PHASES.every((p) => p.blocking)).toBe(true);
    expect(REASONING_PHASES.every((p) => p.implemented)).toBe(true);
  });

  it("each phase has multiple checks", () => {
    for (const phase of REASONING_PHASES) {
      expect(phase.checks.length).toBeGreaterThanOrEqual(5);
    }
  });

  it("domain_boundaries phase identifies platform, entities, APIs, compliance, deployment", () => {
    const phase = REASONING_PHASES.find((p) => p.id === "domain_boundaries");
    const checks = phase?.checks.join(" ");
    expect(checks).toContain("platform");
    expect(checks).toContain("database entities");
    expect(checks).toContain("third-party APIs");
    expect(checks).toContain("compliance");
    expect(checks).toContain("deployment");
  });

  it("security_audit phase verifies PCI-DSS, encryption, JWT/OAuth, RBAC, RLS", () => {
    const phase = REASONING_PHASES.find((p) => p.id === "security_audit");
    const checks = phase?.checks.join(" ");
    expect(checks).toContain("PCI-DSS");
    expect(checks).toContain("AES-256-GCM");
    expect(checks).toContain("JWT");
    expect(checks).toContain("RBAC");
    expect(checks).toContain("RLS");
  });

  it("component_topology phase maps component trees, state boundaries, API interfaces", () => {
    const phase = REASONING_PHASES.find((p) => p.id === "component_topology");
    const checks = phase?.checks.join(" ");
    expect(checks).toContain("component tree");
    expect(checks).toContain("state boundaries");
    expect(checks).toContain("API interfaces");
    expect(checks).toContain("data flow");
  });

  it("dependency_validation phase ensures zero missing imports + valid types", () => {
    const phase = REASONING_PHASES.find((p) => p.id === "dependency_validation");
    const checks = phase?.checks.join(" ");
    expect(checks).toContain("missing imports");
    expect(checks).toContain("Tailwind");
    expect(checks).toContain("typed interfaces");
    expect(checks).toContain("'any'");
  });

  it("runSystem2Reasoning — all phases pass for a valid prompt", () => {
    const result = runSystem2Reasoning({
      prompt: "Build a fintech app with loan management, KYC, and Stripe payments.",
      domain: "fintech",
      compliance: ["kyc_aml", "pci_dss"],
      platforms: ["web", "mobile"],
    });
    expect(result.allPassed).toBe(true);
    expect(result.canGenerateCode).toBe(true);
    expect(result.phases).toHaveLength(4);
    expect(result.phases.every((p) => p.status === "passed")).toBe(true);
    expect(result.failureReason).toBeNull();
  });

  it("runSystem2Reasoning — summary includes domain boundaries + security audit", () => {
    const result = runSystem2Reasoning({ prompt: "Build a SaaS app." });
    expect(result.summary.domainBoundaries.platforms).toBeDefined();
    expect(result.summary.domainBoundaries.entities).toContain("users");
    expect(result.summary.securityAudit.pciDssCompliant).toBe(true);
    expect(result.summary.securityAudit.encryptionVerified).toBe(true);
    expect(result.summary.securityAudit.rbacConfigured).toBe(true);
    expect(result.summary.componentTopology.screens).toBeGreaterThan(0);
    expect(result.summary.dependencyValidation.missingImports).toBe(0);
    expect(result.summary.dependencyValidation.anyTypeCount).toBe(0);
  });

  it("ReasoningPhaseId covers 4 phases", () => {
    const ids: ReasoningPhaseId[] = ["domain_boundaries", "security_audit", "component_topology", "dependency_validation"];
    expect(ids).toHaveLength(4);
  });
});

// ───────────────────────────────────────────────
// 3. Output Rules
// ───────────────────────────────────────────────

describe("3 — System Output Rules", () => {
  it("has 25 output rules across 10 categories", () => {
    expect(OUTPUT_RULES).toHaveLength(25);
    const categories = new Set(OUTPUT_RULES.map((r) => r.category));
    expect(categories.size).toBe(10);
  });

  it("has blocking rules for file completeness, TypeScript, security, validation, testing, accessibility, deployment", () => {
    const blockingCategories = new Set(
      OUTPUT_RULES.filter((r) => r.blocking).map((r) => r.category),
    );
    expect(blockingCategories.has("file_completeness")).toBe(true);
    expect(blockingCategories.has("typescript_strict")).toBe(true);
    expect(blockingCategories.has("security")).toBe(true);
    expect(blockingCategories.has("validation")).toBe(true);
    expect(blockingCategories.has("testing")).toBe(true);
    expect(blockingCategories.has("accessibility")).toBe(true);
    expect(blockingCategories.has("deployment")).toBe(true);
  });

  it("OUT-01: deliver complete files (no placeholders)", () => {
    const rule = OUTPUT_RULES.find((r) => r.id === "OUT-01");
    expect(rule?.rule).toContain("complete");
    expect(rule?.blocking).toBe(true);
  });

  it("OUT-02: never place placeholders or TODOs", () => {
    const rule = OUTPUT_RULES.find((r) => r.id === "OUT-02");
    expect(rule?.rule).toContain("placeholders");
    expect(rule?.blocking).toBe(true);
  });

  it("OUT-06: no 'any' types — use 'unknown' + narrowing", () => {
    const rule = OUTPUT_RULES.find((r) => r.id === "OUT-06");
    expect(rule?.rule).toContain("'any'");
    expect(rule?.enforcement).toContain("unknown");
  });

  it("OUT-09: sensitive fields encrypted with AES-256-GCM", () => {
    const rule = OUTPUT_RULES.find((r) => r.id === "OUT-09");
    expect(rule?.rule).toContain("AES-256-GCM");
    expect(rule?.blocking).toBe(true);
  });

  it("OutputRuleCategory covers 10 categories", () => {
    const c: OutputRuleCategory[] = [
      "file_completeness", "typescript_strict", "security", "validation",
      "documentation", "testing", "styling", "performance", "accessibility", "deployment",
    ];
    expect(c).toHaveLength(10);
  });
});

// ───────────────────────────────────────────────
// 4. Prohibited Patterns
// ───────────────────────────────────────────────

describe("4 — Prohibited Patterns", () => {
  it("has 12 prohibited patterns", () => {
    expect(PROHIBITED_PATTERNS).toHaveLength(12);
  });

  it("prohibits TODOs, stubs, 'any', @ts-ignore, console.log, eval, innerHTML", () => {
    const patterns = PROHIBITED_PATTERNS.map((p) => p.pattern);
    expect(patterns).toContain("// TODO: implement later");
    expect(patterns).toContain("// stub");
    expect(patterns).toContain("any");
    expect(patterns).toContain("@ts-ignore");
    expect(patterns).toContain("console.log");
    expect(patterns).toContain("eval(");
    expect(patterns).toContain("innerHTML");
  });

  it("every prohibited pattern has a reason + alternative", () => {
    for (const pattern of PROHIBITED_PATTERNS) {
      expect(pattern.reason.length).toBeGreaterThan(0);
      expect(pattern.alternative.length).toBeGreaterThan(0);
    }
  });
});

// ───────────────────────────────────────────────
// 5. Compliance Gates
// ───────────────────────────────────────────────

describe("5 — Compliance Validation Gates", () => {
  it("has 10 compliance gates", () => {
    expect(COMPLIANCE_GATES).toHaveLength(10);
  });

  it("all 10 gates are blocking + implemented", () => {
    expect(COMPLIANCE_GATES.every((g) => g.blocking)).toBe(true);
    expect(COMPLIANCE_GATES.every((g) => g.implemented)).toBe(true);
  });

  it("includes typecheck, lint, build, tests, security_scan, rls_check, encryption_check, rbac_check", () => {
    const ids = COMPLIANCE_GATES.map((g) => g.id);
    expect(ids).toContain("typecheck");
    expect(ids).toContain("lint");
    expect(ids).toContain("build");
    expect(ids).toContain("tests");
    expect(ids).toContain("security_scan");
    expect(ids).toContain("rls_check");
    expect(ids).toContain("encryption_check");
    expect(ids).toContain("rbac_check");
  });

  it("ComplianceGateId covers 10 gates", () => {
    const ids: ComplianceGateId[] = [
      "typecheck", "lint", "build", "tests", "security_scan",
      "rls_check", "encryption_check", "rbac_check", "audit_check", "pii_check",
    ];
    expect(ids).toHaveLength(10);
  });
});

// ───────────────────────────────────────────────
// 6. Master System Prompt
// ───────────────────────────────────────────────

describe("6 — Master System Prompt", () => {
  it("buildMasterSystemPrompt returns all components", () => {
    const prompt = buildMasterSystemPrompt();
    expect(prompt.mission).toBe(CORE_MISSION);
    expect(prompt.reasoningPhases).toBe(REASONING_PHASES);
    expect(prompt.outputRules).toBe(OUTPUT_RULES);
    expect(prompt.prohibitedPatterns).toBe(PROHIBITED_PATTERNS);
    expect(prompt.complianceGates).toBe(COMPLIANCE_GATES);
    expect(prompt.renderedPrompt).toBeTruthy();
  });

  it("rendered prompt contains all sections", () => {
    const prompt = buildMasterSystemPrompt();
    const rendered = prompt.renderedPrompt;
    expect(rendered).toContain("SUPA AI OS — ENTERPRISE SYSTEM PROMPT");
    expect(rendered).toContain("## CORE MISSION");
    expect(rendered).toContain("## MANDATORY PRE-GENERATION REASONING");
    expect(rendered).toContain("## SYSTEM OUTPUT RULES");
    expect(rendered).toContain("## PROHIBITED PATTERNS");
    expect(rendered).toContain("## COMPLIANCE VALIDATION GATES");
    expect(rendered).toContain("## OUTPUT CONTRACT");
  });

  it("rendered prompt contains the 4 reasoning phases", () => {
    const rendered = buildMasterSystemPrompt().renderedPrompt;
    expect(rendered).toContain("DOMAIN BOUNDARIES");
    expect(rendered).toContain("SECURITY AUDIT");
    expect(rendered).toContain("COMPONENT TOPOLOGY");
    expect(rendered).toContain("DEPENDENCY VALIDATION");
  });
});

// ───────────────────────────────────────────────
// 7. Core Pipeline
// ───────────────────────────────────────────────

describe("7 — Core Pipeline", () => {
  it("has 3 pipeline steps", () => {
    expect(PIPELINE_STEPS).toHaveLength(3);
    const ids = PIPELINE_STEPS.map((s) => s.id);
    expect(ids).toContain("step1_system_prompt");
    expect(ids).toContain("step2_fintech_engine");
    expect(ids).toContain("step3_runtime_engine");
  });

  it("all 3 steps are blocking + implemented", () => {
    expect(PIPELINE_STEPS.every((s) => s.blocking)).toBe(true);
    expect(PIPELINE_STEPS.every((s) => s.implemented)).toBe(true);
  });

  it("Step 1 is System Prompt (Architect + Security + Code Generator)", () => {
    const step = PIPELINE_STEPS.find((s) => s.id === "step1_system_prompt");
    expect(step?.title).toContain("System Prompt");
    expect(step?.description).toContain("System 2 Reasoning");
  });

  it("Step 2 is Fintech Engine (KYC + Ledger + Loan + Payments)", () => {
    const step = PIPELINE_STEPS.find((s) => s.id === "step2_fintech_engine");
    expect(step?.title).toContain("Fintech Engine");
    expect(step?.description).toContain("KYC");
  });

  it("Step 3 is Runtime Engine (WebContainers + Self-Healing)", () => {
    const step = PIPELINE_STEPS.find((s) => s.id === "step3_runtime_engine");
    expect(step?.title).toContain("Runtime Engine");
    expect(step?.description).toContain("WebContainer");
    expect(step?.description.toLowerCase()).toContain("self-healing");
  });

  it("executePipeline runs all 3 steps + completes", () => {
    const result = executePipeline({ prompt: "Build a fintech app." });
    expect(result.completed).toBe(true);
    expect(result.steps).toHaveLength(3);
    expect(result.steps.every((s) => s.status === "completed")).toBe(true);
    expect(result.sessionId).toBeTruthy();
  });

  it("PipelineStepId covers 3 steps", () => {
    const ids: PipelineStepId[] = ["step1_system_prompt", "step2_fintech_engine", "step3_runtime_engine"];
    expect(ids).toHaveLength(3);
  });
});

// ───────────────────────────────────────────────
// Overall verification
// ───────────────────────────────────────────────

describe("System Prompt — overall verification", () => {
  it("verifySystemPrompt reports all implemented", () => {
    const v = verifySystemPrompt();
    expect(v.totalReasoningPhases).toBe(4);
    expect(v.totalOutputRules).toBe(25);
    expect(v.totalProhibitedPatterns).toBe(12);
    expect(v.totalComplianceGates).toBe(10);
    expect(v.totalPipelineSteps).toBe(3);
    expect(v.allImplemented).toBe(true);
  });
});
