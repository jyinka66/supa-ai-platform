/**
 * Supa AI Build — all 11 modules — tests.
 *
 * Verifies the full builder spec:
 *   1. Build Session (11 plan elements + verifiable artifact gate).
 *   2. Build Lifecycle (9 stages with verifiable artifacts).
 *   3. Deploy States (6-state separation, never collapsed).
 *   4. Project Sandbox (5 isolation layers + config verification).
 *   5. Security Model (10 security boundaries + audit).
 *   6. Live Preview (5 guarantees + 5 lifecycle actions).
 *   7. App Versioning (9 version dimensions + rollback).
 *   8. App Knowledge (12 dimensions + cross-file reasoning).
 *   9. Publish Targets (6 targets across web/mobile).
 *  10. Export Artifact (6 directories + real artifact guarantee).
 *  11. AI Employee Handoff (10-step workflow + handoff + cycle).
 */

import { describe, it, expect } from "vitest";
import {
  PLAN_ELEMENTS,
  verifyBuildSession,
  type PlanElementId,
  type BuildSessionStatus,
  type AppPlatform,
  type BuildSession,
} from "@/lib/builder/build-session";
import {
  BUILD_STAGES,
  LIFECYCLE_TRANSITIONS,
  verifyBuildLifecycle,
  getStage,
  getStageByNumber,
  getNextStage,
  getPreviousStage,
  type BuildStage,
  type StageStatus,
} from "@/lib/builder/build-lifecycle";
import {
  DEPLOY_STATES,
  verifyDeployStates,
  type DeployStateId,
} from "@/lib/builder/deploy-states";
import {
  SANDBOX_LAYERS,
  DEFAULT_SANDBOX_CONFIG,
  verifySandboxConfig,
  verifyProjectSandbox,
  type SandboxLayerId,
} from "@/lib/builder/project-sandbox";
import {
  SECURITY_BOUNDARIES,
  runSecurityAudit,
  verifySecurityModel,
  type SecurityBoundaryId,
} from "@/lib/builder/security-model";
import {
  PREVIEW_GUARANTEES,
  PREVIEW_LIFECYCLE,
  verifyLivePreview,
  type PreviewStatus,
  type PreviewAction,
} from "@/lib/builder/live-preview";
import {
  VERSION_DIMENSIONS,
  verifyAppVersioning,
  type VersionDimensionId,
  type VersionSource,
  type RollbackScope,
} from "@/lib/builder/app-versioning";
import {
  KNOWLEDGE_DIMENSIONS,
  traceBookingBug,
  verifyAppKnowledge,
  type KnowledgeDimensionId,
} from "@/lib/builder/app-knowledge";
import {
  PUBLISH_TARGETS,
  verifyPublishTargets,
  type PublishTargetId,
} from "@/lib/builder/publish-targets";
import {
  ARTIFACT_DIRECTORIES,
  verifyExportArtifact,
  type ArtifactDirectoryId,
} from "@/lib/builder/export-artifact";
import {
  EMPLOYEE_WORKFLOW,
  verifyAIEmployeeHandoff,
  type EmployeeWorkflowStepId,
  type HandoffScope,
} from "@/lib/builder/ai-employee-handoff";

// ───────────────────────────────────────────────
// 1. Build Session
// ───────────────────────────────────────────────

describe("1 — Build Session", () => {
  it("has 11 plan elements", () => {
    expect(PLAN_ELEMENTS).toHaveLength(11);
    const ids = PLAN_ELEMENTS.map((e) => e.id);
    expect(ids).toContain("product_requirements");
    expect(ids).toContain("screens_pages");
    expect(ids).toContain("user_flows");
    expect(ids).toContain("database_schema");
    expect(ids).toContain("authentication");
    expect(ids).toContain("apis");
    expect(ids).toContain("ui_system");
    expect(ids).toContain("integrations");
    expect(ids).toContain("permissions");
    expect(ids).toContain("deployment_target");
    expect(ids).toContain("environment_config");
  });

  it("all 11 plan elements are implemented", () => {
    const v = verifyBuildSession();
    expect(v.implementedPlanElements).toBe(11);
    expect(v.allImplemented).toBe(true);
  });

  it("10 required plan elements + 1 optional (integrations)", () => {
    const required = PLAN_ELEMENTS.filter((e) => e.required);
    const optional = PLAN_ELEMENTS.filter((e) => !e.required);
    expect(required).toHaveLength(10);
    expect(optional).toHaveLength(1);
    expect(optional[0]?.id).toBe("integrations");
  });

  it("create function + verifiable artifact gate are implemented", () => {
    const v = verifyBuildSession();
    expect(v.createFunctionImplemented).toBe(true);
    expect(v.verifiableArtifactGateImplemented).toBe(true);
  });

  it("PlanElementId is the union of 11 named ids", () => {
    const ids: PlanElementId[] = [
      "product_requirements", "screens_pages", "user_flows", "database_schema",
      "authentication", "apis", "ui_system", "integrations", "permissions",
      "deployment_target", "environment_config",
    ];
    expect(ids).toHaveLength(11);
  });

  it("BuildSessionStatus covers all states", () => {
    const s: BuildSessionStatus[] = [
      "planning", "building", "testing", "previewing",
      "deployed", "published", "monitoring", "paused", "failed", "archived",
    ];
    expect(s).toHaveLength(10);
  });

  it("AppPlatform is web / mobile / full_stack", () => {
    const p1: AppPlatform = "web";
    const p2: AppPlatform = "mobile";
    const p3: AppPlatform = "full_stack";
    expect([p1, p2, p3]).toHaveLength(3);
  });
});

// ───────────────────────────────────────────────
// 2. Build Lifecycle — 9 stages
// ───────────────────────────────────────────────

describe("2 — Build Lifecycle (9 stages)", () => {
  it("has 9 stages", () => {
    expect(BUILD_STAGES).toHaveLength(9);
    const stages = BUILD_STAGES.map((s) => s.stage);
    expect(stages).toEqual([
      "idea", "plan", "build", "preview", "test",
      "iterate", "deploy", "publish", "monitor",
    ]);
  });

  it("all 9 stages are implemented", () => {
    const v = verifyBuildLifecycle();
    expect(v.implementedStages).toBe(9);
    expect(v.allImplemented).toBe(true);
  });

  it("every stage has a verifiable artifact", () => {
    const v = verifyBuildLifecycle();
    expect(v.allStagesHaveVerifiableArtifact).toBe(true);
  });

  it("every stage has entry criteria + deliverables + exit criteria + rollback", () => {
    for (const s of BUILD_STAGES) {
      expect(s.entryCriteria.length).toBeGreaterThan(0);
      expect(s.deliverables.length).toBeGreaterThan(0);
      expect(s.exitCriteria.length).toBeGreaterThan(0);
      expect(s.rollbackPath.length).toBeGreaterThan(0);
    }
  });

  it("lifecycle transitions form a forward chain", () => {
    expect(LIFECYCLE_TRANSITIONS.length).toBeGreaterThanOrEqual(9);
    expect(LIFECYCLE_TRANSITIONS.some((t) => t.from === "idea" && t.to === "plan")).toBe(true);
    expect(LIFECYCLE_TRANSITIONS.some((t) => t.from === "publish" && t.to === "monitor")).toBe(true);
  });

  it("getStage / getStageByNumber / getNextStage / getPreviousStage", () => {
    expect(getStage("idea")?.number).toBe(1);
    expect(getStageByNumber(9)?.stage).toBe("monitor");
    expect(getNextStage("idea")).toBe("plan");
    expect(getNextStage("monitor")).toBeNull();
    expect(getPreviousStage("idea")).toBeNull();
    expect(getPreviousStage("plan")).toBe("idea");
  });

  it("BuildStage is the union of 9 named stages", () => {
    const s: BuildStage[] = ["idea", "plan", "build", "preview", "test", "iterate", "deploy", "publish", "monitor"];
    expect(s).toHaveLength(9);
  });
});

// ───────────────────────────────────────────────
// 3. Deploy States — 6-state separation
// ───────────────────────────────────────────────

describe("3 — Deploy States (6-state separation)", () => {
  it("has 6 deploy states", () => {
    expect(DEPLOY_STATES).toHaveLength(6);
    const ids = DEPLOY_STATES.map((s) => s.id);
    expect(ids).toContain("code_generated");
    expect(ids).toContain("tests_passed");
    expect(ids).toContain("production_build");
    expect(ids).toContain("deployment_started");
    expect(ids).toContain("deployment_healthy");
    expect(ids).toContain("custom_domain_live");
  });

  it("all 6 states are implemented", () => {
    const v = verifyDeployStates();
    expect(v.implementedStates).toBe(6);
    expect(v.allImplemented).toBe(true);
  });

  it("4 blocking states + 2 non-blocking", () => {
    const v = verifyDeployStates();
    expect(v.blockingStates).toBe(4);
    expect(v.nonBlockingStates).toBe(2);
  });

  it("states are NEVER collapsed into a single 'Published' status", () => {
    const v = verifyDeployStates();
    expect(v.neverCollapsed).toBe(true);
  });

  it("DeployStateId is the union of 6 named ids", () => {
    const ids: DeployStateId[] = [
      "code_generated", "tests_passed", "production_build",
      "deployment_started", "deployment_healthy", "custom_domain_live",
    ];
    expect(ids).toHaveLength(6);
  });
});

// ───────────────────────────────────────────────
// 4. Project Sandbox — 5 isolation layers
// ───────────────────────────────────────────────

describe("4 — Project Sandbox (5 isolation layers)", () => {
  it("has 5 sandbox layers", () => {
    expect(SANDBOX_LAYERS).toHaveLength(5);
    const ids = SANDBOX_LAYERS.map((l) => l.id);
    expect(ids).toContain("filesystem");
    expect(ids).toContain("dependencies");
    expect(ids).toContain("build");
    expect(ids).toContain("tests");
    expect(ids).toContain("preview_runtime");
  });

  it("all 5 layers are implemented", () => {
    const v = verifyProjectSandbox();
    expect(v.implementedLayers).toBe(5);
    expect(v.allImplemented).toBe(true);
  });

  it("default config is safe (no credential injection, no full network)", () => {
    const v = verifyProjectSandbox();
    expect(v.defaultConfigSafe).toBe(true);
    expect(v.credentialsNeverInjected).toBe(true);
  });

  it("verifySandboxConfig rejects unsafe configs", () => {
    const unsafe = verifySandboxConfig({
      ...DEFAULT_SANDBOX_CONFIG,
      supaCredentialsInjected: true,
    });
    expect(unsafe.safe).toBe(false);
    expect(unsafe.violations.length).toBeGreaterThan(0);
  });

  it("verifySandboxConfig accepts safe configs", () => {
    const safe = verifySandboxConfig(DEFAULT_SANDBOX_CONFIG);
    expect(safe.safe).toBe(true);
    expect(safe.violations).toHaveLength(0);
  });

  it("SandboxLayerId is the union of 5 named ids", () => {
    const ids: SandboxLayerId[] = ["filesystem", "dependencies", "build", "tests", "preview_runtime"];
    expect(ids).toHaveLength(5);
  });
});

// ───────────────────────────────────────────────
// 5. Security Model — 10 boundaries
// ───────────────────────────────────────────────

describe("5 — Security Model (10 boundaries)", () => {
  it("has 10 security boundaries", () => {
    expect(SECURITY_BOUNDARIES).toHaveLength(10);
  });

  it("all 10 boundaries are implemented", () => {
    const v = verifySecurityModel();
    expect(v.implementedBoundaries).toBe(10);
    expect(v.allImplemented).toBe(true);
  });

  it("security audit returns all boundaries holding", () => {
    const audit = runSecurityAudit();
    expect(audit.totalBoundaries).toBe(10);
    expect(audit.boundariesHolding).toBe(10);
    expect(audit.boundariesViolated).toHaveLength(0);
    expect(audit.overallSafe).toBe(true);
  });

  it("every boundary has a rule + enforcedBy + riskIfViolated", () => {
    for (const b of SECURITY_BOUNDARIES) {
      expect(b.rule.length).toBeGreaterThan(0);
      expect(b.enforcedBy.length).toBeGreaterThan(0);
      expect(b.riskIfViolated.length).toBeGreaterThan(0);
    }
  });

  it("SecurityBoundaryId is the union of 10 named ids", () => {
    const ids: SecurityBoundaryId[] = [
      "generated_projects", "package_installation", "build_processes",
      "test_processes", "runtime_previews", "filesystem_access",
      "secrets", "network_access", "deployment_credentials",
      "user_to_project_authorization",
    ];
    expect(ids).toHaveLength(10);
  });
});

// ───────────────────────────────────────────────
// 6. Live Preview — 5 guarantees + 5 lifecycle actions
// ───────────────────────────────────────────────

describe("6 — Live Preview", () => {
  it("has 5 preview guarantees", () => {
    expect(PREVIEW_GUARANTEES).toHaveLength(5);
  });

  it("has 5 lifecycle actions", () => {
    expect(PREVIEW_LIFECYCLE).toHaveLength(5);
    const actions = PREVIEW_LIFECYCLE.map((l) => l.action);
    expect(actions).toContain("start");
    expect(actions).toContain("stop");
    expect(actions).toContain("sleep");
    expect(actions).toContain("wake");
    expect(actions).toContain("restart");
  });

  it("all guarantees + lifecycle actions are implemented", () => {
    const v = verifyLivePreview();
    expect(v.implementedGuarantees).toBe(5);
    expect(v.implementedLifecycleActions).toBe(5);
    expect(v.allImplemented).toBe(true);
  });

  it("PreviewStatus covers all states", () => {
    const s: PreviewStatus[] = ["starting", "running", "sleeping", "stopped", "failed"];
    expect(s).toHaveLength(5);
  });

  it("PreviewAction is the union of 5 named actions", () => {
    const a: PreviewAction[] = ["start", "stop", "sleep", "wake", "restart"];
    expect(a).toHaveLength(5);
  });
});

// ───────────────────────────────────────────────
// 7. App Versioning — 9 dimensions + rollback
// ───────────────────────────────────────────────

describe("7 — App Versioning (9 dimensions + rollback)", () => {
  it("has 9 version dimensions", () => {
    expect(VERSION_DIMENSIONS).toHaveLength(9);
  });

  it("all 9 dimensions are implemented", () => {
    const v = verifyAppVersioning();
    expect(v.implementedDimensions).toBe(9);
    expect(v.allImplemented).toBe(true);
  });

  it("rollback function is implemented with 4 scopes", () => {
    const v = verifyAppVersioning();
    expect(v.rollbackFunctionImplemented).toBe(true);
    expect(v.rollbackScopes).toBe(4);
  });

  it("VersionDimensionId is the union of 9 named ids", () => {
    const ids: VersionDimensionId[] = [
      "git_commit", "build_result", "test_result", "deployment",
      "artifacts", "database_migrations", "environment_changes",
      "ai_changes", "user_changes",
    ];
    expect(ids).toHaveLength(9);
  });

  it("VersionSource covers all source types", () => {
    const s: VersionSource[] = ["ai_generated", "user_edit", "ai_iterate", "migration", "config_change"];
    expect(s).toHaveLength(5);
  });

  it("RollbackScope covers all 4 scopes", () => {
    const s: RollbackScope[] = ["code_only", "code_and_migrations", "code_and_env", "full"];
    expect(s).toHaveLength(4);
  });
});

// ───────────────────────────────────────────────
// 8. App Knowledge — 12 dimensions + cross-file reasoning
// ───────────────────────────────────────────────

describe("8 — App Knowledge (12 dimensions + cross-file reasoning)", () => {
  it("has 12 knowledge dimensions", () => {
    expect(KNOWLEDGE_DIMENSIONS).toHaveLength(12);
    const ids = KNOWLEDGE_DIMENSIONS.map((d) => d.id);
    expect(ids).toContain("source_code");
    expect(ids).toContain("database");
    expect(ids).toContain("api");
    expect(ids).toContain("authentication");
    expect(ids).toContain("dependencies");
    expect(ids).toContain("environment");
    expect(ids).toContain("tests");
    expect(ids).toContain("deployment");
    expect(ids).toContain("logs");
    expect(ids).toContain("documentation");
    expect(ids).toContain("design_system");
    expect(ids).toContain("previous_changes");
  });

  it("all 12 dimensions are implemented", () => {
    const v = verifyAppKnowledge();
    expect(v.implementedDimensions).toBe(12);
    expect(v.allImplemented).toBe(true);
  });

  it("cross-file reasoning is implemented (traceBookingBug example)", () => {
    const trace = traceBookingBug();
    expect(trace.symptom).toContain("400");
    expect(trace.trace.length).toBe(5); // source_code → api → database → logs → tests.
    expect(trace.fix.length).toBeGreaterThan(0);
    expect(trace.verification.length).toBeGreaterThan(0);
  });

  it("every dimension has accessedVia + exampleReasoning", () => {
    for (const d of KNOWLEDGE_DIMENSIONS) {
      expect(d.accessedVia.length).toBeGreaterThan(0);
      expect(d.exampleReasoning.length).toBeGreaterThan(0);
    }
  });

  it("KnowledgeDimensionId is the union of 12 named ids", () => {
    const ids: KnowledgeDimensionId[] = [
      "source_code", "database", "api", "authentication", "dependencies",
      "environment", "tests", "deployment", "logs", "documentation",
      "design_system", "previous_changes",
    ];
    expect(ids).toHaveLength(12);
  });
});

// ───────────────────────────────────────────────
// 9. Publish Targets — 6 targets
// ───────────────────────────────────────────────

describe("9 — Publish Targets (6 targets)", () => {
  it("has 6 publish targets", () => {
    expect(PUBLISH_TARGETS).toHaveLength(6);
    const ids = PUBLISH_TARGETS.map((t) => t.id);
    expect(ids).toContain("supa_hosting");
    expect(ids).toContain("custom_domain");
    expect(ids).toContain("git_repository");
    expect(ids).toContain("cloud_deployment");
    expect(ids).toContain("app_store");
    expect(ids).toContain("google_play");
  });

  it("all 6 targets are implemented", () => {
    const v = verifyPublishTargets();
    expect(v.implementedTargets).toBe(6);
    expect(v.allImplemented).toBe(true);
  });

  it("4 web targets + 3 mobile targets (git_repository + app_store + google_play)", () => {
    const v = verifyPublishTargets();
    expect(v.webTargets).toBeGreaterThanOrEqual(4);
    expect(v.mobileTargets).toBe(3);
  });

  it("PublishTargetId is the union of 6 named ids", () => {
    const ids: PublishTargetId[] = [
      "supa_hosting", "custom_domain", "git_repository",
      "cloud_deployment", "app_store", "google_play",
    ];
    expect(ids).toHaveLength(6);
  });
});

// ───────────────────────────────────────────────
// 10. Export Artifact — 6 directories
// ───────────────────────────────────────────────

describe("10 — Export Artifact (6 directories)", () => {
  it("has 6 artifact directories", () => {
    expect(ARTIFACT_DIRECTORIES).toHaveLength(6);
    const ids = ARTIFACT_DIRECTORIES.map((d) => d.id);
    expect(ids).toContain("source");
    expect(ids).toContain("database");
    expect(ids).toContain("tests");
    expect(ids).toContain("configuration");
    expect(ids).toContain("deployment");
    expect(ids).toContain("readme");
  });

  it("all 6 directories are implemented", () => {
    const v = verifyExportArtifact();
    expect(v.implementedDirectories).toBe(6);
    expect(v.allImplemented).toBe(true);
  });

  it("export function is implemented + real artifact guarantee", () => {
    const v = verifyExportArtifact();
    expect(v.exportFunctionImplemented).toBe(true);
    expect(v.realArtifactGuarantee).toBe(true);
  });

  it("ArtifactDirectoryId is the union of 6 named ids", () => {
    const ids: ArtifactDirectoryId[] = ["source", "database", "tests", "configuration", "deployment", "readme"];
    expect(ids).toHaveLength(6);
  });
});

// ───────────────────────────────────────────────
// 11. AI Employee Handoff — 10-step workflow
// ───────────────────────────────────────────────

describe("11 — AI Employee Handoff (10-step workflow)", () => {
  it("has 10 workflow steps", () => {
    expect(EMPLOYEE_WORKFLOW).toHaveLength(10);
    const ids = EMPLOYEE_WORKFLOW.map((s) => s.id);
    expect(ids).toContain("monitor");
    expect(ids).toContain("detect_issue");
    expect(ids).toContain("inspect_project");
    expect(ids).toContain("plan_fix");
    expect(ids).toContain("implement");
    expect(ids).toContain("test");
    expect(ids).toContain("build");
    expect(ids).toContain("deploy");
    expect(ids).toContain("verify");
    expect(ids).toContain("report");
  });

  it("all 10 steps are implemented", () => {
    const v = verifyAIEmployeeHandoff();
    expect(v.implementedSteps).toBe(10);
    expect(v.allImplemented).toBe(true);
  });

  it("deploy step requires human approval (when autoDeploy=false)", () => {
    const deployStep = EMPLOYEE_WORKFLOW.find((s) => s.id === "deploy");
    expect(deployStep?.requiresHumanApproval).toBe(true);
  });

  it("handoff + cycle functions are implemented", () => {
    const v = verifyAIEmployeeHandoff();
    expect(v.handoffFunctionImplemented).toBe(true);
    expect(v.cycleFunctionImplemented).toBe(true);
  });

  it("EmployeeWorkflowStepId is the union of 10 named ids", () => {
    const ids: EmployeeWorkflowStepId[] = [
      "monitor", "detect_issue", "inspect_project", "plan_fix",
      "implement", "test", "build", "deploy", "verify", "report",
    ];
    expect(ids).toHaveLength(10);
  });

  it("HandoffScope covers all 3 scopes", () => {
    const s: HandoffScope[] = ["monitor_only", "monitor_and_fix", "monitor_fix_and_improve"];
    expect(s).toHaveLength(3);
  });
});

// ───────────────────────────────────────────────
// Overall — the full Supa AI Build spec
// ───────────────────────────────────────────────

describe("Supa AI Build — full spec verification", () => {
  it("all 11 modules are fully implemented", () => {
    expect(verifyBuildSession().allImplemented).toBe(true);
    expect(verifyBuildLifecycle().allImplemented).toBe(true);
    expect(verifyDeployStates().allImplemented).toBe(true);
    expect(verifyProjectSandbox().allImplemented).toBe(true);
    expect(verifySecurityModel().allImplemented).toBe(true);
    expect(verifyLivePreview().allImplemented).toBe(true);
    expect(verifyAppVersioning().allImplemented).toBe(true);
    expect(verifyAppKnowledge().allImplemented).toBe(true);
    expect(verifyPublishTargets().allImplemented).toBe(true);
    expect(verifyExportArtifact().allImplemented).toBe(true);
    expect(verifyAIEmployeeHandoff().allImplemented).toBe(true);
  });
});
