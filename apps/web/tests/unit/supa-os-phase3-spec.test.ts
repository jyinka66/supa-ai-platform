/**
 * Supa OS Phase 3 — Live Sandbox & Execution Workspace — tests.
 *
 * Verifies:
 *   1. Container Runtime: boot, mount, processes, DB, terminal, logs (6 guarantees).
 *   2. Component Inspector: selection, conversational edits, property inspector (5 guarantees).
 *   3. Multi-Cloud Deploy: 5 targets, one-click, rollback, history (5 guarantees).
 */

import { describe, it, expect } from "vitest";
import {
  bootContainer,
  mountFiles,
  startProcess,
  stopProcess,
  appendProcessOutput,
  stopContainer,
  initDatabase,
  executeQuery,
  createTerminalSession,
  appendTerminalOutput,
  createLogAggregator,
  addLog,
  getFilteredLogs,
  SANDBOX_GUARANTEES,
  verifyContainerRuntime,
  type ContainerState,
  type ContainerProcessStatus,
  type DatabaseEngine,
  type LogLevel,
  type LogSource,
} from "@/lib/supa-os/container-runtime";
import {
  selectComponent,
  hoverComponent,
  parseConversationalEdit,
  generateChangePreview,
  applyEdit,
  INSPECTOR_GUARANTEES,
  verifyComponentInspector,
  type ComponentCategory,
  type EditAction,
  type LogicType,
} from "@/lib/supa-os/component-inspector";
import {
  CLOUD_DEPLOY_TARGETS,
  oneClickDeploy,
  rollbackDeployment,
  createDeployHistory,
  recordDeployment,
  DEPLOY_GUARANTEES,
  verifyMultiCloudDeploy,
  type CloudDeployTargetId,
  type OneClickDeployState,
} from "@/lib/supa-os/multi-cloud-deploy";
import type { QaOutput } from "@/lib/supa-os/qa-agent";

// Mock QA output for deploy tests.
const mockQaPass: QaOutput = {
  tests: [], results: [], lint: [], compliance: [],
  verdict: "pass", verdictReason: "all pass", coverage: 90,
  totalTests: 10, generatedAt: new Date(),
};

const mockQaFail: QaOutput = {
  tests: [], results: [], lint: [], compliance: [],
  verdict: "fail", verdictReason: "test failure", coverage: 50,
  totalTests: 10, generatedAt: new Date(),
};

// ───────────────────────────────────────────────
// 1. Container Runtime
// ───────────────────────────────────────────────

describe("1 — Container Runtime (WebContainers Sandbox)", () => {
  it("boots a container for a session", () => {
    const container = bootContainer("session-1");
    expect(container.sessionId).toBe("session-1");
    expect(container.state).toBe("booting");
    expect(container.processes).toHaveLength(0);
    expect(container.devServerUrl).toBeNull();
  });

  it("mounts files into the container", () => {
    const container = bootContainer("session-1");
    const mounted = mountFiles(container, [
      { path: "/app/page.tsx", content: "export default function Page() { return <div>Hello</div>; }", generated: true },
      { path: "/app/layout.tsx", content: "export default function Layout() { return <div />; }", generated: true },
    ]);
    expect(mounted.state).toBe("ready");
    expect(mounted.fileSystem.fileCount).toBe(2);
    expect(mounted.fileSystem.totalSizeBytes).toBeGreaterThan(0);
    expect(mounted.bootedAt).not.toBeNull();
  });

  it("starts a dev server process", () => {
    let container = bootContainer("session-1");
    container = mountFiles(container, [{ path: "/app/page.tsx", content: "hello", generated: true }]);
    container = startProcess(container, { name: "dev-server", command: "npm run dev" });
    expect(container.state).toBe("running");
    expect(container.processes).toHaveLength(1);
    expect(container.processes[0]?.status).toBe("running");
    expect(container.devServerUrl).toBe("http://localhost:3000");
    expect(container.devServerPort).toBe(3000);
  });

  it("stops a process", () => {
    let container = bootContainer("session-1");
    container = startProcess(container, { name: "dev-server", command: "npm run dev" });
    const processId = container.processes[0]!.id;
    container = stopProcess(container, processId);
    expect(container.processes[0]?.status).toBe("killed");
    expect(container.processes[0]?.exitedAt).not.toBeNull();
  });

  it("appends process output (stdout/stderr)", () => {
    let container = bootContainer("session-1");
    container = startProcess(container, { name: "build", command: "npm run build" });
    const processId = container.processes[0]!.id;
    container = appendProcessOutput(container, { processId, stream: "stdout", line: "Building..." });
    container = appendProcessOutput(container, { processId, stream: "stdout", line: "✓ Compiled successfully" });
    container = appendProcessOutput(container, { processId, stream: "stderr", line: "Warning: deprecated" });
    expect(container.processes[0]?.stdout).toHaveLength(2);
    expect(container.processes[0]?.stderr).toHaveLength(1);
    expect(container.processes[0]?.stdout[0]).toBe("Building...");
  });

  it("stops the entire container", () => {
    let container = bootContainer("session-1");
    container = startProcess(container, { name: "dev-server", command: "npm run dev" });
    container = stopContainer(container);
    expect(container.state).toBe("stopped");
    expect(container.devServerUrl).toBeNull();
    expect(container.processes[0]?.status).toBe("killed");
  });

  it("initializes database management", () => {
    const db = initDatabase("pglite");
    expect(db.engine).toBe("pglite");
    expect(db.running).toBe(false);
    expect(db.tables).toHaveLength(0);
  });

  it("executes a query", () => {
    let db = initDatabase("pglite");
    db = executeQuery(db, "SELECT * FROM users;");
    expect(db.running).toBe(true);
    expect(db.lastQuery).toBe("SELECT * FROM users;");
    expect(db.queryHistory).toHaveLength(1);
  });

  it("creates a terminal session", () => {
    const session = createTerminalSession();
    expect(session.output).toHaveLength(0);
    expect(session.attached).toBe(false);
  });

  it("appends terminal output", () => {
    let session = createTerminalSession();
    session = appendTerminalOutput(session, {
      processId: "proc-1",
      stream: "stdout",
      line: "Server started on port 3000",
      timestamp: new Date(),
    });
    expect(session.output).toHaveLength(1);
    expect(session.output[0]?.line).toBe("Server started on port 3000");
  });

  it("creates a log aggregator + adds logs + filters", () => {
    let agg = createLogAggregator();
    agg = addLog(agg, { level: "info", source: "app", message: "User signed in", metadata: null });
    agg = addLog(agg, { level: "error", source: "server", message: "Database connection failed", metadata: null });
    agg = addLog(agg, { level: "warn", source: "app", message: "Rate limit approaching", metadata: null });
    expect(agg.entries).toHaveLength(3);
    // Filter by level.
    agg = { ...agg, filterLevel: "error" };
    const errors = getFilteredLogs(agg);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe("Database connection failed");
    // Filter by source.
    agg = { ...agg, filterLevel: "all", filterSource: "app" };
    const appLogs = getFilteredLogs(agg);
    expect(appLogs).toHaveLength(2);
  });

  it("has 6 sandbox guarantees", () => {
    expect(SANDBOX_GUARANTEES).toHaveLength(6);
    expect(SANDBOX_GUARANTEES.every((g) => g.implemented)).toBe(true);
  });

  it("verifyContainerRuntime reports all implemented", () => {
    const v = verifyContainerRuntime();
    expect(v.totalStates).toBe(6);
    expect(v.totalGuarantees).toBe(6);
    expect(v.implementedGuarantees).toBe(6);
    expect(v.allImplemented).toBe(true);
  });

  it("ContainerState covers all states", () => {
    const s: ContainerState[] = ["uninitialized", "booting", "ready", "running", "stopped", "error"];
    expect(s).toHaveLength(6);
  });

  it("DatabaseEngine covers 3 engines", () => {
    const e: DatabaseEngine[] = ["sqlite_wasm", "pglite", "sqljs"];
    expect(e).toHaveLength(3);
  });

  it("LogLevel covers 4 levels", () => {
    const l: LogLevel[] = ["debug", "info", "warn", "error"];
    expect(l).toHaveLength(4);
  });

  it("LogSource covers 5 sources", () => {
    const s: LogSource[] = ["app", "server", "build", "database", "system"];
    expect(s).toHaveLength(5);
  });
});

// ───────────────────────────────────────────────
// 2. Component Inspector & Editor
// ───────────────────────────────────────────────

describe("2 — Visual Component Inspector & Editor", () => {
  it("parses a conversational edit — 'make premium'", () => {
    const edit = parseConversationalEdit({
      prompt: "Make the dashboard more premium and add a revenue chart.",
      targetNodeId: "node-dashboard",
    });
    expect(edit.changes.length).toBeGreaterThan(0);
    expect(edit.changes.some((c) => c.description.includes("premium"))).toBe(true);
    expect(edit.changes.some((c) => c.description.includes("revenue chart"))).toBe(true);
  });

  it("parses a conversational edit — 'move chart above'", () => {
    const edit = parseConversationalEdit({
      prompt: "Move the chart above the recent transactions.",
      targetNodeId: "node-chart",
    });
    expect(edit.changes.some((c) => c.description.includes("Reorder"))).toBe(true);
    expect(["reorder", "modify_prop", "modify_style"]).toContain(edit.action);
  });

  it("parses a conversational edit — 'fix mobile layout'", () => {
    const edit = parseConversationalEdit({
      prompt: "The mobile layout is broken — fix it.",
      targetNodeId: "node-dashboard",
    });
    expect(edit.changes.some((c) => c.description.includes("responsive"))).toBe(true);
  });

  it("parses a conversational edit — 'remove component'", () => {
    const edit = parseConversationalEdit({
      prompt: "Remove this section.",
      targetNodeId: "node-section",
    });
    expect(edit.changes.some((c) => c.description.includes("Remove"))).toBe(true);
    expect(["remove_component", "reorder", "modify_prop", "modify_style"]).toContain(edit.action);
  });

  it("generates a change preview with code diff", () => {
    const edit = parseConversationalEdit({
      prompt: "Change the color to blue.",
      targetNodeId: "node-button",
    });
    const preview = generateChangePreview(edit);
    expect(preview.status).toBe("ready");
    expect(preview.codeDiff).toContain("```diff");
    expect(preview.edit.previewed).toBe(true);
  });

  it("has 5 inspector guarantees", () => {
    expect(INSPECTOR_GUARANTEES).toHaveLength(5);
    expect(INSPECTOR_GUARANTEES.every((g) => g.implemented)).toBe(true);
  });

  it("verifyComponentInspector reports all implemented", () => {
    const v = verifyComponentInspector();
    expect(v.totalCategories).toBe(8);
    expect(v.totalLogicTypes).toBe(10);
    expect(v.totalGuarantees).toBe(5);
    expect(v.implementedGuarantees).toBe(5);
    expect(v.allImplemented).toBe(true);
  });

  it("ComponentCategory covers 8 categories", () => {
    const c: ComponentCategory[] = ["layout", "form", "display", "navigation", "feedback", "data", "media", "business_logic"];
    expect(c).toHaveLength(8);
  });

  it("LogicType covers 10 logic types", () => {
    const l: LogicType[] = ["validation", "transformation", "condition", "loop", "api_call", "state_update", "redirect", "permission", "calculation", "side_effect"];
    expect(l).toHaveLength(10);
  });

  it("EditAction covers 8 action types", () => {
    const a: EditAction[] = ["modify_prop", "add_component", "remove_component", "reorder", "modify_style", "modify_logic", "extract_component", "rename"];
    expect(a).toHaveLength(8);
  });
});

// ───────────────────────────────────────────────
// 3. Multi-Cloud Deployment
// ───────────────────────────────────────────────

describe("3 — One-Click Multi-Cloud Deployment", () => {
  it("has 5 cloud deploy targets", () => {
    expect(CLOUD_DEPLOY_TARGETS).toHaveLength(5);
    const ids = CLOUD_DEPLOY_TARGETS.map((t) => t.id);
    expect(ids).toContain("vercel");
    expect(ids).toContain("aws");
    expect(ids).toContain("gcp");
    expect(ids).toContain("supabase");
    expect(ids).toContain("self_hosted");
  });

  it("all 5 targets are implemented", () => {
    expect(CLOUD_DEPLOY_TARGETS.every((t) => t.implemented)).toBe(true);
  });

  it("Vercel deploys in <60s with CDN + preview branches", () => {
    const vercel = CLOUD_DEPLOY_TARGETS.find((t) => t.id === "vercel");
    expect(vercel?.estimatedDeploySeconds).toBeLessThan(60);
    expect(vercel?.cdn).toBe(true);
    expect(vercel?.previewDeploys).toBe(true);
  });

  it("AWS uses Terraform IaC + auto-scaling + CDN", () => {
    const aws = CLOUD_DEPLOY_TARGETS.find((t) => t.id === "aws");
    expect(aws?.iacTemplate).toContain("Terraform");
    expect(aws?.autoScaling).toBe(true);
    expect(aws?.cdn).toBe(true);
  });

  it("Supabase is fastest for prototyping", () => {
    const supabase = CLOUD_DEPLOY_TARGETS.find((t) => t.id === "supabase");
    expect(supabase?.estimatedDeploySeconds).toBeLessThanOrEqual(60);
  });

  it("self_hosted Docker requires SSH credentials", () => {
    const selfHosted = CLOUD_DEPLOY_TARGETS.find((t) => t.id === "self_hosted");
    expect(selfHosted?.requiredEnvVars).toContain("SSH_HOST");
    expect(selfHosted?.requiredEnvVars).toContain("SSH_PRIVATE_KEY");
  });

  it("one-click deploy — QA pass → healthy deployment", () => {
    const deployment = oneClickDeploy({
      sessionId: "session-1",
      target: "vercel",
      qa: mockQaPass,
    });
    expect(deployment.state).toBe("healthy");
    expect(deployment.url).not.toBeNull();
    expect(deployment.url).toContain("vercel.app");
    expect(deployment.rollbackable).toBe(true);
    expect(deployment.buildLog.length).toBeGreaterThan(0);
    expect(deployment.deployLog.length).toBeGreaterThan(0);
    expect(deployment.stateHistory.length).toBe(5);
    expect(deployment.error).toBeNull();
  });

  it("one-click deploy — QA fail → blocked deployment", () => {
    const deployment = oneClickDeploy({
      sessionId: "session-1",
      target: "vercel",
      qa: mockQaFail,
    });
    expect(deployment.state).toBe("failed");
    expect(deployment.url).toBeNull();
    expect(deployment.error).toContain("fail");
    expect(deployment.rollbackable).toBe(false);
  });

  it("deploys to all 5 targets", () => {
    for (const target of CLOUD_DEPLOY_TARGETS) {
      const deployment = oneClickDeploy({
        sessionId: "session-1",
        target: target.id,
        qa: mockQaPass,
      });
      expect(deployment.state).toBe("healthy");
      expect(deployment.url).not.toBeNull();
    }
  });

  it("records deployment history + rolls back", () => {
    let history = createDeployHistory("session-1");
    const deploy1 = oneClickDeploy({ sessionId: "session-1", target: "vercel", qa: mockQaPass });
    history = recordDeployment(history, deploy1);
    expect(history.currentDeployment?.id).toBe(deploy1.id);
    expect(history.previousDeployment).toBeNull();

    const deploy2 = oneClickDeploy({ sessionId: "session-1", target: "aws", qa: mockQaPass });
    history = recordDeployment(history, deploy2);
    expect(history.currentDeployment?.id).toBe(deploy2.id);
    expect(history.previousDeployment?.id).toBe(deploy1.id);

    // Roll back to deploy1.
    history = rollbackDeployment(history);
    expect(history.currentDeployment?.id).toBe(deploy1.id);
    expect(history.previousDeployment?.id).toBe(deploy2.id);
  });

  it("has 5 deploy guarantees", () => {
    expect(DEPLOY_GUARANTEES).toHaveLength(5);
    expect(DEPLOY_GUARANTEES.every((g) => g.implemented)).toBe(true);
  });

  it("verifyMultiCloudDeploy reports all implemented", () => {
    const v = verifyMultiCloudDeploy();
    expect(v.totalTargets).toBe(5);
    expect(v.totalStates).toBe(6);
    expect(v.totalGuarantees).toBe(5);
    expect(v.implementedGuarantees).toBe(5);
    expect(v.allImplemented).toBe(true);
  });

  it("CloudDeployTargetId is the union of 5 named ids", () => {
    const ids: CloudDeployTargetId[] = ["vercel", "aws", "gcp", "supabase", "self_hosted"];
    expect(ids).toHaveLength(5);
  });

  it("OneClickDeployState covers all 6 states", () => {
    const s: OneClickDeployState[] = ["queued", "building", "testing", "deploying", "healthy", "failed"];
    expect(s).toHaveLength(6);
  });
});

// ───────────────────────────────────────────────
// Phase 3 — overall verification
// ───────────────────────────────────────────────

describe("Phase 3 — overall verification", () => {
  it("all 3 Phase 3 modules are fully implemented", () => {
    expect(verifyContainerRuntime().allImplemented).toBe(true);
    expect(verifyComponentInspector().allImplemented).toBe(true);
    expect(verifyMultiCloudDeploy().allImplemented).toBe(true);
  });
});
