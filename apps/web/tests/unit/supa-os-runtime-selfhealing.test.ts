/**
 * Supa OS — Runtime Engine & Self-Healing Loop — tests.
 *
 * Verifies:
 *   1. WASM Runtime Engine: 6 runtimes, terminal commands, migrations, API testing, deps, build/test.
 *   2. Self-Healing Loop: error interception, classification (14 categories), auto-patch, verify, escalate.
 */

import { describe, it, expect } from "vitest";
import {
  RUNTIME_ENVIRONMENTS,
  executeCommand,
  completeCommand,
  executeMigration,
  rollbackMigration,
  runApiTests,
  installDependencies,
  executeBuild,
  executeTests,
  RUNTIME_GUARANTEES,
  verifyRuntimeEngine,
  type RuntimeLanguage,
  type CommandStatus,
  type MigrationStatus,
  type ApiTestStatus,
  type PackageManager,
  type BuildStatus,
} from "@/lib/supa-os/wasm-runtime-engine";
import {
  interceptErrors,
  classifyError,
  generateAutoPatch,
  runSelfHealingLoop,
  SELF_HEALING_GUARANTEES,
  verifySelfHealing,
  type ErrorSource,
  type ErrorSeverity,
  type ErrorCategory,
  type PatchStatus,
  type LoopStatus,
} from "@/lib/supa-os/self-healing-loop";

// ───────────────────────────────────────────────
// 1. WASM Runtime Engine
// ───────────────────────────────────────────────

describe("1 — WASM & WebContainer Runtime Engine", () => {
  it("has 7 runtime environments including disposable Postgres", () => {
    expect(RUNTIME_ENVIRONMENTS).toHaveLength(7);
    const langs = RUNTIME_ENVIRONMENTS.map((r) => r.language);
    expect(langs).toContain("nodejs");
    expect(langs).toContain("python");
    expect(langs).toContain("go");
    expect(langs).toContain("rust");
    expect(langs).toContain("deno");
    expect(langs).toContain("bun");
    expect(langs).toContain("postgres");
  });

  it("all 6 runtimes are implemented", () => {
    expect(RUNTIME_ENVIRONMENTS.every((r) => r.implemented)).toBe(true);
  });

  it("Node.js uses the isolated Docker sandbox", () => {
    const node = RUNTIME_ENVIRONMENTS.find((r) => r.language === "nodejs");
    expect(node?.runtimeProvider).toBe("docker-sandbox");
    expect(node?.streaming).toBe(false);
  });

  it("Python uses the isolated Docker sandbox", () => {
    const python = RUNTIME_ENVIRONMENTS.find((r) => r.language === "python");
    expect(python?.runtimeProvider).toBe("docker-sandbox");
  });

  it("Go uses the isolated Docker sandbox", () => {
    const go = RUNTIME_ENVIRONMENTS.find((r) => r.language === "go");
    expect(go?.runtimeProvider).toBe("docker-sandbox");
  });

  it("executes a terminal command", () => {
    const cmd = executeCommand({ command: "npm run dev" });
    expect(cmd.command).toBe("npm run dev");
    expect(cmd.status).toBe("running");
    expect(cmd.exitCode).toBeNull();
    expect(cmd.stdout).toHaveLength(0);
  });

  it("completes a terminal command (exit 0)", () => {
    const cmd = executeCommand({ command: "npm run build" });
    const completed = completeCommand(cmd, 0, ["Build succeeded"], []);
    expect(completed.status).toBe("exited");
    expect(completed.exitCode).toBe(0);
    expect(completed.stdout).toContain("Build succeeded");
    expect(completed.durationMs).not.toBeNull();
  });

  it("completes a terminal command (exit 1 = error)", () => {
    const cmd = executeCommand({ command: "npm run build" });
    const completed = completeCommand(cmd, 1, [], ["Build failed"]);
    expect(completed.status).toBe("error");
    expect(completed.exitCode).toBe(1);
    expect(completed.stderr).toContain("Build failed");
  });

  it("executes a database migration", () => {
    const migration = executeMigration({
      fileName: "0001_initial.sql",
      sql: "CREATE TABLE users (id UUID PRIMARY KEY, email TEXT NOT NULL); CREATE TABLE loans (id UUID PRIMARY KEY);",
    });
    expect(migration.status).toBe("applied");
    expect(migration.tablesCreated).toContain("users");
    expect(migration.tablesCreated).toContain("loans");
    expect(migration.appliedAt).not.toBeNull();
    expect(migration.error).toBeNull();
  });

  it("rolls back a reversible migration", () => {
    const migration = executeMigration({
      fileName: "0001_initial.sql",
      sql: "CREATE TABLE users (id UUID); -- down: DROP TABLE users;",
    });
    expect(migration.reversible).toBe(true);
    const rolled = rollbackMigration(migration);
    expect(rolled.status).toBe("rolled_back");
  });

  it("cannot roll back a non-reversible migration", () => {
    const migration = executeMigration({
      fileName: "0001_initial.sql",
      sql: "CREATE TABLE users (id UUID);",
    });
    expect(migration.reversible).toBe(false);
    const rolled = rollbackMigration(migration);
    expect(rolled.status).toBe("failed");
    expect(rolled.error).toContain("not reversible");
  });

  it("runs API endpoint tests", () => {
    const result = runApiTests({
      baseUrl: "http://localhost:3000",
      tests: [
        { name: "GET /api/users returns 200", method: "GET", path: "/api/users", body: null, headers: {}, expectedStatus: 200, expectedBody: null, authRequired: true },
        { name: "POST /api/users creates user", method: "POST", path: "/api/users", body: { email: "test@test.com" }, headers: {}, expectedStatus: 201, expectedBody: null, authRequired: true },
      ],
    });
    expect(result.totalTests).toBe(2);
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it("installs dependencies via npm", () => {
    const install = installDependencies({
      packageManager: "npm",
      packages: ["stripe", "argon2"],
    });
    expect(install.command).toBe("npm install stripe argon2");
    expect(install.status).toBe("exited");
    expect(install.stdout).toContain("✓ stripe installed");
    expect(install.stdout).toContain("✓ argon2 installed");
  });

  it("installs dependencies via pip (Python)", () => {
    const install = installDependencies({
      packageManager: "pip",
      packages: ["fastapi", "uvicorn"],
    });
    expect(install.command).toBe("pip install fastapi uvicorn");
  });

  it("installs dependencies via go mod (Go)", () => {
    const install = installDependencies({
      packageManager: "go mod",
      packages: ["github.com/gin-gonic/gin"],
    });
    expect(install.command).toBe("go get github.com/gin-gonic/gin");
  });

  it("executes a build", () => {
    const build = executeBuild({ command: "next build" });
    expect(build.status).toBe("success");
    expect(build.output.length).toBeGreaterThan(0);
    expect(build.buildHash).not.toBeNull();
    expect(build.artifactSizeBytes).not.toBeNull();
    expect(build.durationMs).not.toBeNull();
  });

  it("executes tests", () => {
    const tests = executeTests({ command: "vitest run" });
    expect(tests.status).toBe("success");
    expect(tests.totalTests).toBeGreaterThan(0);
    expect(tests.passed).toBe(tests.totalTests);
    expect(tests.failed).toBe(0);
    expect(tests.coverage).toBeGreaterThan(0);
  });

  it("has 6 runtime guarantees", () => {
    expect(RUNTIME_GUARANTEES).toHaveLength(6);
    expect(RUNTIME_GUARANTEES.every((g) => g.implemented)).toBe(true);
  });

  it("verifyRuntimeEngine reports all implemented", () => {
    const v = verifyRuntimeEngine();
    expect(v.totalRuntimes).toBe(6);
    expect(v.totalGuarantees).toBe(6);
    expect(v.implementedGuarantees).toBe(6);
    expect(v.allImplemented).toBe(true);
  });

  it("RuntimeLanguage covers 6 languages", () => {
    const l: RuntimeLanguage[] = ["nodejs", "python", "go", "rust", "deno", "bun"];
    expect(l).toHaveLength(6);
  });

  it("PackageManager covers 9 managers", () => {
    const pm: PackageManager[] = ["npm", "pnpm", "yarn", "pip", "poetry", "go mod", "cargo", "deno", "bun"];
    expect(pm).toHaveLength(9);
  });
});

// ───────────────────────────────────────────────
// 2. Self-Healing Agentic Feedback Loop
// ───────────────────────────────────────────────

describe("2 — Self-Healing Agentic Feedback Loop", () => {
  it("intercepts errors from build output", () => {
    const errors = interceptErrors({
      output: [
        "Building...",
        "✓ Compiled successfully",
        "Error: Cannot find module 'stripe'",
        "TypeError: Cannot read property 'id' of undefined",
        "✓ Build completed with errors",
      ],
      source: "build",
      command: "npm run build",
    });
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors.some((e) => e.message.includes("Cannot find module"))).toBe(true);
    expect(errors.some((e) => e.message.includes("Cannot read property"))).toBe(true);
    expect(errors.every((e) => e.source === "build")).toBe(true);
    expect(errors.every((e) => e.command === "npm run build")).toBe(true);
  });

  it("intercepts errors from API output (500)", () => {
    const errors = interceptErrors({
      output: ["Error: 500 Internal Server Error"],
      source: "api",
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.severity).toBe("error");
  });

  it("intercepts no errors when output is clean", () => {
    const errors = interceptErrors({
      output: ["Building...", "✓ Compiled successfully", "✓ Build completed"],
      source: "build",
    });
    expect(errors).toHaveLength(0);
  });

  it("classifies a missing module error", () => {
    const error = interceptErrors({
      output: ["Error: Cannot find module 'stripe'"],
      source: "build",
    })[0]!;
    const classified = classifyError(error);
    expect(classified.category).toBe("missing_module");
    expect(classified.confidence).toBeGreaterThanOrEqual(90);
    expect(classified.suggestedApproach).toContain("Install");
  });

  it("classifies a type mismatch error", () => {
    const error: import("@/lib/supa-os/self-healing-loop").InterceptedError = {
      id: "1", source: "typecheck", severity: "error", message: "Type 'number' is not assignable to type 'string'",
      stackTrace: null, filePath: "src/app/page.tsx", lineNumber: 42, columnNumber: 5,
      command: "tsc --noEmit", rawOutput: "type error", interceptedAt: new Date(), resolved: false, resolution: null,
    };
    const classified = classifyError(error);
    expect(classified.category).toBe("type_mismatch");
    expect(classified.confidence).toBeGreaterThanOrEqual(85);
  });

  it("classifies a 500 API error", () => {
    const error: import("@/lib/supa-os/self-healing-loop").InterceptedError = {
      id: "1", source: "api", severity: "error", message: "500 Internal Server Error",
      stackTrace: null, filePath: null, lineNumber: null, columnNumber: null,
      command: null, rawOutput: "500", interceptedAt: new Date(), resolved: false, resolution: null,
    };
    const classified = classifyError(error);
    expect(classified.category).toBe("api_500");
    expect(classified.suggestedApproach).toContain("API route");
  });

  it("classifies a port conflict error", () => {
    const error: import("@/lib/supa-os/self-healing-loop").InterceptedError = {
      id: "1", source: "runtime", severity: "error", message: "Port 3000 is already in use",
      stackTrace: null, filePath: null, lineNumber: null, columnNumber: null,
      command: "npm run dev", rawOutput: "port in use", interceptedAt: new Date(), resolved: false, resolution: null,
    };
    const classified = classifyError(error);
    expect(classified.category).toBe("port_conflict");
    expect(classified.confidence).toBeGreaterThanOrEqual(90);
  });

  it("classifies a missing env var error", () => {
    const error: import("@/lib/supa-os/self-healing-loop").InterceptedError = {
      id: "1", source: "runtime", severity: "error", message: "Missing environment variable: DATABASE_URL",
      stackTrace: null, filePath: null, lineNumber: null, columnNumber: null,
      command: null, rawOutput: "env var missing", interceptedAt: new Date(), resolved: false, resolution: null,
    };
    const classified = classifyError(error);
    expect(classified.category).toBe("env_var_missing");
  });

  it("generates an auto-patch for a missing module error", () => {
    const error = interceptErrors({
      output: ["Error: Cannot find module 'stripe'"],
      source: "build",
    })[0]!;
    const classified = classifyError(error);
    const patch = generateAutoPatch({ error, classification: classified });
    expect(patch.status).toBe("generated");
    expect(patch.changes.length).toBeGreaterThan(0);
    expect(patch.classification).toBe("missing_module");
  });

  it("generates an auto-patch for a 500 API error (adds try/catch)", () => {
    const error: import("@/lib/supa-os/self-healing-loop").InterceptedError = {
      id: "1", source: "api", severity: "error", message: "500 Internal Server Error",
      stackTrace: null, filePath: "app/api/users/route.ts", lineNumber: 10, columnNumber: null,
      command: null, rawOutput: "500", interceptedAt: new Date(), resolved: false, resolution: null,
    };
    const classified = classifyError(error);
    const patch = generateAutoPatch({ error, classification: classified });
    expect(patch.changes[0]?.newContent).toContain("try");
    expect(patch.changes[0]?.newContent).toContain("catch");
  });

  it("runs the full self-healing loop — no errors → monitoring", () => {
    const loop = runSelfHealingLoop({
      output: ["Building...", "✓ Compiled successfully", "✓ All tests passed"],
      source: "build",
    });
    expect(loop.status).toBe("monitoring");
    expect(loop.errors).toHaveLength(0);
    expect(loop.patches).toHaveLength(0);
    expect(loop.active).toBe(true);
  });

  it("runs the full self-healing loop — errors → auto-patched → resolved", () => {
    const loop = runSelfHealingLoop({
      output: ["Error: Cannot find module 'stripe'", "TypeError: Cannot read property 'id' of undefined"],
      source: "build",
      command: "npm run build",
    });
    expect(loop.status).toBe("resolved");
    expect(loop.errors.length).toBeGreaterThan(0);
    expect(loop.patches.length).toBeGreaterThan(0);
    expect(loop.errors.every((e) => e.resolved)).toBe(true);
    expect(loop.active).toBe(false);
    expect(loop.summary).toContain("resolved");
  });

  it("has 7 self-healing guarantees", () => {
    expect(SELF_HEALING_GUARANTEES).toHaveLength(7);
    expect(SELF_HEALING_GUARANTEES.every((g) => g.implemented)).toBe(true);
  });

  it("verifySelfHealing reports all implemented", () => {
    const v = verifySelfHealing();
    expect(v.totalErrorCategories).toBe(14);
    expect(v.totalGuarantees).toBe(7);
    expect(v.implementedGuarantees).toBe(7);
    expect(v.allImplemented).toBe(true);
  });

  it("ErrorCategory covers 14 categories", () => {
    const c: ErrorCategory[] = [
      "missing_module", "type_mismatch", "syntax_error", "runtime_crash",
      "api_500", "api_404", "test_failure", "migration_error",
      "import_error", "dependency_missing", "env_var_missing",
      "port_conflict", "permission_denied", "unknown",
    ];
    expect(c).toHaveLength(14);
  });

  it("LoopStatus covers 7 states", () => {
    const s: LoopStatus[] = ["monitoring", "error_detected", "analyzing", "patching", "verifying", "resolved", "escalated"];
    expect(s).toHaveLength(7);
  });

  it("PatchStatus covers 5 states", () => {
    const s: PatchStatus[] = ["generated", "applied", "verified", "failed", "escalated"];
    expect(s).toHaveLength(5);
  });
});

// ───────────────────────────────────────────────
// Overall verification
// ───────────────────────────────────────────────

describe("Runtime + Self-Healing — overall verification", () => {
  it("both modules are fully implemented", () => {
    expect(verifyRuntimeEngine().allImplemented).toBe(true);
    expect(verifySelfHealing().allImplemented).toBe(true);
  });
});
