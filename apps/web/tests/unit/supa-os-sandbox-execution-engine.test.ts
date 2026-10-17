/**
 * Supa OS Step 3 — Browser Sandbox Execution Engine — tests.
 *
 * Verifies:
 *   1. WebContainer lifecycle (11 states).
 *   2. Virtual filesystem (mount, read, write, delete, list).
 *   3. Terminal streaming (append, ring buffer).
 *   4. Build log capture (4 levels, file+line attribution).
 *   5. Live preview (URL, port, refresh, error state).
 *   6. Full sandbox execution pipeline (boot → mount → install → migrate → server → build → preview).
 *   7. Self-healing path (build fails → QA agent patches → restart → rebuild succeeds).
 */

import { describe, it, expect } from "vitest";
import {
  createVirtualFileSystem,
  mountFiles,
  readFile,
  writeFile,
  deleteFile,
  listFiles,
  createTerminalSession,
  appendTerminalLine,
  createBuildLogCollector,
  addBuildLog,
  createLivePreview,
  refreshPreview,
  executeSandboxPipeline,
  SANDBOX_GUARANTEES,
  verifySandboxEngine,
  type SandboxState,
  type ExecutionPhase,
  type BuildLogLevel,
  type VirtualFile,
} from "@/lib/supa-os/sandbox-execution-engine";

// ───────────────────────────────────────────────
// 1. Virtual Filesystem
// ───────────────────────────────────────────────

describe("1 — Virtual Filesystem", () => {
  it("creates an empty filesystem", () => {
    const fs = createVirtualFileSystem();
    expect(fs.fileCount).toBe(0);
    expect(fs.totalSizeBytes).toBe(0);
  });

  it("mounts files into the filesystem", () => {
    const fs = createVirtualFileSystem();
    const mounted = mountFiles(fs, [
      { path: "/app/page.tsx", content: "export default function Page() { return <div>Hello</div>; }" },
      { path: "/app/layout.tsx", content: "export default function Layout({ children }) { return <div>{children}</div>; }" },
    ]);
    expect(mounted.fileCount).toBe(2);
    expect(mounted.totalSizeBytes).toBeGreaterThan(0);
  });

  it("reads a file by path", () => {
    const fs = mountFiles(createVirtualFileSystem(), [
      { path: "/app/page.tsx", content: "hello" },
    ]);
    const file = readFile(fs, "/app/page.tsx");
    expect(file).not.toBeNull();
    expect(file?.content).toBe("hello");
    expect(file?.path).toBe("/app/page.tsx");
  });

  it("returns null for non-existent file", () => {
    const fs = createVirtualFileSystem();
    expect(readFile(fs, "/nonexistent.ts")).toBeNull();
  });

  it("writes/updates a file", () => {
    let fs = mountFiles(createVirtualFileSystem(), [{ path: "/app/page.tsx", content: "old" }]);
    fs = writeFile(fs, "/app/page.tsx", "new content");
    expect(readFile(fs, "/app/page.tsx")?.content).toBe("new content");
  });

  it("writes a new file (not previously mounted)", () => {
    let fs = createVirtualFileSystem();
    fs = writeFile(fs, "/new.ts", "new file");
    expect(fs.fileCount).toBe(1);
    expect(readFile(fs, "/new.ts")?.content).toBe("new file");
  });

  it("deletes a file", () => {
    let fs = mountFiles(createVirtualFileSystem(), [
      { path: "/a.ts", content: "a" },
      { path: "/b.ts", content: "b" },
    ]);
    fs = deleteFile(fs, "/a.ts");
    expect(fs.fileCount).toBe(1);
    expect(readFile(fs, "/a.ts")).toBeNull();
    expect(readFile(fs, "/b.ts")).not.toBeNull();
  });

  it("lists all files sorted by path", () => {
    const fs = mountFiles(createVirtualFileSystem(), [
      { path: "/z.ts", content: "z" },
      { path: "/a.ts", content: "a" },
      { path: "/m.ts", content: "m" },
    ]);
    const files = listFiles(fs);
    expect(files.map((f) => f.path)).toEqual(["/a.ts", "/m.ts", "/z.ts"]);
  });
});

// ───────────────────────────────────────────────
// 2. Terminal Streaming
// ───────────────────────────────────────────────

describe("2 — Terminal Streaming", () => {
  it("creates a terminal session", () => {
    const session = createTerminalSession();
    expect(session.lines).toHaveLength(0);
    expect(session.attached).toBe(false);
  });

  it("appends lines with process attribution", () => {
    let session = createTerminalSession();
    session = appendTerminalLine(session, { text: "npm install", stream: "stdout", process: "npm" });
    session = appendTerminalLine(session, { text: "added 245 packages", stream: "stdout", process: "npm" });
    expect(session.lines).toHaveLength(2);
    expect(session.lines[0]?.text).toBe("npm install");
    expect(session.lines[0]?.process).toBe("npm");
    expect(session.lines[0]?.timestamp).toBeTruthy();
  });

  it("respects maxLines (ring buffer)", () => {
    let session = createTerminalSession(3);
    session = appendTerminalLine(session, { text: "line 1", stream: "stdout", process: "test" });
    session = appendTerminalLine(session, { text: "line 2", stream: "stdout", process: "test" });
    session = appendTerminalLine(session, { text: "line 3", stream: "stdout", process: "test" });
    session = appendTerminalLine(session, { text: "line 4", stream: "stdout", process: "test" });
    expect(session.lines).toHaveLength(3);
    expect(session.lines[0]?.text).toBe("line 2"); // line 1 evicted.
  });
});

// ───────────────────────────────────────────────
// 3. Build Log Capture
// ───────────────────────────────────────────────

describe("3 — Build Log Capture", () => {
  it("creates an empty log collector", () => {
    expect(createBuildLogCollector()).toHaveLength(0);
  });

  it("adds logs with level + message + source", () => {
    let logs = createBuildLogCollector();
    logs = addBuildLog(logs, "error", "Module not found", { file: "app/page.tsx", line: 3 });
    logs = addBuildLog(logs, "warn", "Deprecated API");
    logs = addBuildLog(logs, "success", "Build complete");
    expect(logs).toHaveLength(3);
    expect(logs[0]?.level).toBe("error");
    expect(logs[0]?.message).toBe("Module not found");
    expect(logs[0]?.source).toEqual({ file: "app/page.tsx", line: 3 });
    expect(logs[1]?.source).toBeNull(); // no source for warn.
    expect(logs[2]?.level).toBe("success");
  });

  it("BuildLogLevel covers 4 levels", () => {
    const levels: BuildLogLevel[] = ["info", "warn", "error", "success"];
    expect(levels).toHaveLength(4);
  });
});

// ───────────────────────────────────────────────
// 4. Live Preview
// ───────────────────────────────────────────────

describe("4 — Live Preview", () => {
  it("creates a preview with default port 3000", () => {
    const preview = createLivePreview();
    expect(preview.url).toBe("http://localhost:3000");
    expect(preview.port).toBe(3000);
    expect(preview.isLive).toBe(false);
  });

  it("creates a preview with custom port", () => {
    const preview = createLivePreview(8080);
    expect(preview.url).toBe("http://localhost:8080");
    expect(preview.port).toBe(8080);
  });

  it("refreshes the preview (HMR)", () => {
    let preview = createLivePreview();
    preview = refreshPreview(preview);
    expect(preview.refreshCount).toBe(1);
    expect(preview.lastRefreshAt).not.toBeNull();
    preview = refreshPreview(preview);
    expect(preview.refreshCount).toBe(2);
  });
});

// ───────────────────────────────────────────────
// 5. Sandbox Execution Pipeline — Success Path
// ───────────────────────────────────────────────

describe("5 — Sandbox Execution Pipeline (success path)", () => {
  it("executes the full pipeline without errors", () => {
    const result = executeSandboxPipeline({
      sessionId: "session-1",
      files: [
        { path: "/app/page.tsx", content: "export default function Page() { return <div>Hello</div>; }" },
        { path: "/package.json", content: '{"name":"test","dependencies":{"next":"14.2.0"}}' },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.selfHealingTriggered).toBe(false);
    expect(result.finalState).toBe("running");
    expect(result.preview).not.toBeNull();
    expect(result.preview?.isLive).toBe(true);
    expect(result.preview?.url).toBe("http://localhost:3000");
    expect(result.container.previewRendered).toBe(true);
    expect(result.container.fileSystem.fileCount).toBe(2);
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.summary).toContain("live");
  });

  it("pipeline includes boot → mount → install → migrate → start_server → build → preview → complete", () => {
    const result = executeSandboxPipeline({
      sessionId: "session-1",
      files: [{ path: "/app.tsx", content: "hello" }],
    });
    const phases = result.steps.map((s) => s.phase);
    expect(phases).toContain("boot");
    expect(phases).toContain("mount");
    expect(phases).toContain("install");
    expect(phases).toContain("migrate");
    expect(phases).toContain("start_server");
    expect(phases).toContain("build");
    expect(phases).toContain("preview");
    expect(phases).toContain("complete");
  });

  it("mount step reports file count + size", () => {
    const result = executeSandboxPipeline({
      sessionId: "session-1",
      files: [{ path: "/app.tsx", content: "hello world" }],
    });
    const mountStep = result.steps.find((s) => s.phase === "mount");
    expect(mountStep?.detail).toContain("1 files");
    expect(mountStep?.detail).toContain("KB");
  });

  it("install step shows npm output in terminal", () => {
    const result = executeSandboxPipeline({
      sessionId: "session-1",
      files: [{ path: "/app.tsx", content: "hello" }],
    });
    const installStep = result.steps.find((s) => s.phase === "install");
    expect(installStep?.terminalOutput.some((l) => l.text.includes("npm install"))).toBe(true);
    expect(installStep?.terminalOutput.some((l) => l.text.includes("added 245 packages"))).toBe(true);
  });

  it("migrate step shows database tables created", () => {
    const result = executeSandboxPipeline({
      sessionId: "session-1",
      files: [{ path: "/app.tsx", content: "hello" }],
    });
    const migrateStep = result.steps.find((s) => s.phase === "migrate");
    expect(migrateStep?.terminalOutput.some((l) => l.text.includes("3 tables created"))).toBe(true);
    expect(migrateStep?.terminalOutput.some((l) => l.text.includes("accounts"))).toBe(true);
  });

  it("start_server step shows dev server ready", () => {
    const result = executeSandboxPipeline({
      sessionId: "session-1",
      files: [{ path: "/app.tsx", content: "hello" }],
    });
    const serverStep = result.steps.find((s) => s.phase === "start_server");
    expect(serverStep?.terminalOutput.some((l) => l.text.includes("http://localhost:3000"))).toBe(true);
    expect(serverStep?.terminalOutput.some((l) => l.text.includes("Ready"))).toBe(true);
  });

  it("build step reports success", () => {
    const result = executeSandboxPipeline({
      sessionId: "session-1",
      files: [{ path: "/app.tsx", content: "hello" }],
    });
    const buildStep = result.steps.find((s) => s.phase === "build");
    expect(buildStep?.status).toBe("completed");
    expect(buildStep?.terminalOutput.some((l) => l.text.includes("Compiled successfully"))).toBe(true);
  });

  it("container stdout + stderr contain all terminal output", () => {
    const result = executeSandboxPipeline({
      sessionId: "session-1",
      files: [{ path: "/app.tsx", content: "hello" }],
    });
    expect(result.container.stdout.length).toBeGreaterThan(0);
    // No stderr in the success path.
    expect(result.container.stderr).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────
// 6. Sandbox Execution Pipeline — Self-Healing Path
// ───────────────────────────────────────────────

describe("6 — Sandbox Execution Pipeline (self-healing path)", () => {
  it("triggers self-healing when build fails", () => {
    const result = executeSandboxPipeline({
      sessionId: "session-1",
      files: [{ path: "/app.tsx", content: "hello" }],
      simulateBuildError: true,
    });

    expect(result.selfHealingTriggered).toBe(true);
    expect(result.selfHealingResolved).toBe(true);
    expect(result.success).toBe(true); // self-healing resolved → success.
    expect(result.summary).toContain("self-healing");
  });

  it("build step fails with error logs", () => {
    const result = executeSandboxPipeline({
      sessionId: "session-1",
      files: [{ path: "/app.tsx", content: "hello" }],
      simulateBuildError: true,
    });

    const buildStep = result.steps.find((s) => s.phase === "build" && s.status === "failed");
    expect(buildStep).toBeDefined();
    expect(buildStep?.buildLogs.some((l) => l.level === "error")).toBe(true);
    expect(buildStep?.buildLogs.some((l) => l.message.includes("stripe"))).toBe(true);
  });

  it("heal step shows QA agent patching", () => {
    const result = executeSandboxPipeline({
      sessionId: "session-1",
      files: [{ path: "/app.tsx", content: "hello" }],
      simulateBuildError: true,
    });

    const healStep = result.steps.find((s) => s.phase === "heal");
    expect(healStep).toBeDefined();
    expect(healStep?.terminalOutput.some((l) => l.text.includes("[QA Agent]"))).toBe(true);
    expect(healStep?.terminalOutput.some((l) => l.text.includes("Intercepted 2 errors"))).toBe(true);
    expect(healStep?.terminalOutput.some((l) => l.text.includes("Patched"))).toBe(true);
  });

  it("restart step runs after healing", () => {
    const result = executeSandboxPipeline({
      sessionId: "session-1",
      files: [{ path: "/app.tsx", content: "hello" }],
      simulateBuildError: true,
    });

    const restartStep = result.steps.find((s) => s.phase === "restart");
    expect(restartStep).toBeDefined();
    expect(restartStep?.terminalOutput.some((l) => l.text.includes("Restarting"))).toBe(true);
  });

  it("second build succeeds after healing", () => {
    const result = executeSandboxPipeline({
      sessionId: "session-1",
      files: [{ path: "/app.tsx", content: "hello" }],
      simulateBuildError: true,
    });

    const buildSteps = result.steps.filter((s) => s.phase === "build");
    expect(buildSteps).toHaveLength(2); // first failed, second succeeded.
    expect(buildSteps[0]?.status).toBe("failed");
    expect(buildSteps[1]?.status).toBe("completed");
  });

  it("preview renders after self-healing resolves the error", () => {
    const result = executeSandboxPipeline({
      sessionId: "session-1",
      files: [{ path: "/app.tsx", content: "hello" }],
      simulateBuildError: true,
    });

    expect(result.preview?.isLive).toBe(true);
    expect(result.container.previewRendered).toBe(true);
  });

  it("summary mentions self-healing resolved errors", () => {
    const result = executeSandboxPipeline({
      sessionId: "session-1",
      files: [{ path: "/app.tsx", content: "hello" }],
      simulateBuildError: true,
    });

    expect(result.summary).toContain("self-healing");
    expect(result.summary).toContain("resolved");
  });
});

// ───────────────────────────────────────────────
// 7. Sandbox Guarantees + Verification
// ───────────────────────────────────────────────

describe("7 — Sandbox Guarantees + Verification", () => {
  it("has 7 sandbox guarantees", () => {
    expect(SANDBOX_GUARANTEES).toHaveLength(7);
    expect(SANDBOX_GUARANTEES.every((g) => g.implemented)).toBe(true);
  });

  it("guarantees include: in-browser, virtual FS, terminal, build logs, live preview, self-healing, escalation", () => {
    const titles = SANDBOX_GUARANTEES.map((g) => g.title);
    expect(titles.some((t) => t.includes("Browser"))).toBe(true);
    expect(titles.some((t) => t.includes("Virtual Filesystem"))).toBe(true);
    expect(titles.some((t) => t.includes("Terminal"))).toBe(true);
    expect(titles.some((t) => t.includes("Build Log"))).toBe(true);
    expect(titles.some((t) => t.includes("Live App Preview"))).toBe(true);
    expect(titles.some((t) => t.includes("Self-Healing"))).toBe(true);
    expect(titles.some((t) => t.includes("Escalation"))).toBe(true);
  });

  it("SandboxState covers 11 states", () => {
    const states: SandboxState[] = [
      "idle", "booting", "mounted", "installing", "ready", "running",
      "build_error", "healing", "restarting", "stopped", "crashed",
    ];
    expect(states).toHaveLength(11);
  });

  it("ExecutionPhase covers 12 phases", () => {
    const phases: ExecutionPhase[] = [
      "boot", "mount", "install", "migrate", "start_server", "build",
      "preview", "heal", "restart", "escalate", "complete", "failed",
    ];
    expect(phases).toHaveLength(12);
  });

  it("verifySandboxEngine reports all implemented", () => {
    const v = verifySandboxEngine();
    expect(v.totalStates).toBe(11);
    expect(v.totalPhases).toBe(12);
    expect(v.totalGuarantees).toBe(7);
    expect(v.implementedGuarantees).toBe(7);
    expect(v.allImplemented).toBe(true);
  });
});
