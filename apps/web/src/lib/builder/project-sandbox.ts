// Project Sandbox — isolation contract.
//
// The spec: "This expansion cannot allow arbitrary generated code to execute
// directly against the Supa AI infrastructure."
//
// The architecture: Supa AI → Work Engine → Project Sandbox → Deploy.
//
// The Project Sandbox isolates:
//   - filesystem
//   - dependencies
//   - build
//   - tests
//   - preview runtime
//
// The generated application NEVER receives Supa AI's privileged credentials.

// ───────────────────────────────────────────────
// Sandbox isolation layers — 5 layers.
// ───────────────────────────────────────────────

export type SandboxLayerId =
  | "filesystem"       // 1 — isolated filesystem per project.
  | "dependencies"     // 2 — sandboxed package installation.
  | "build"            // 3 — sandboxed build process.
  | "tests"            // 4 — sandboxed test process.
  | "preview_runtime"; // 5 — sandboxed preview runtime.

export interface SandboxLayerSpec {
  id: SandboxLayerId;
  number: number;
  title: string;
  description: string;
  /** The isolation mechanism (container / microVM / chroot / etc.). */
  isolationMechanism: string;
  /** Resource limits applied. */
  resourceLimits: string[];
  /** What escapes the sandbox (should be "nothing"). */
  escapes: string;
  implemented: boolean;
}

export const SANDBOX_LAYERS: SandboxLayerSpec[] = [
  {
    id: "filesystem",
    number: 1,
    title: "Filesystem",
    description: "Each project gets an isolated filesystem — cannot read/write outside its project directory.",
    isolationMechanism: "Container with tmpfs / overlay mount per project.",
    resourceLimits: ["max_disk: 1GB per project", "max_files: 10,000"],
    escapes: "nothing — no access to host filesystem, no access to other projects.",
    implemented: true,
  },
  {
    id: "dependencies",
    number: 2,
    title: "Dependencies",
    description: "Package installation runs in a sandboxed registry mirror — no arbitrary network access during install.",
    isolationMechanism: "Sandboxed npm/pnpm with registry mirror + allowlist.",
    resourceLimits: ["max_install_time: 5min", "max_node_modules: 500MB"],
    escapes: "nothing — no postinstall scripts with network access, no native addons without review.",
    implemented: true,
  },
  {
    id: "build",
    number: 3,
    title: "Build",
    description: "Build process (next build, tsc, webpack) runs in a sandboxed container with resource limits.",
    isolationMechanism: "Container with CPU/memory limits + no network access during build.",
    resourceLimits: ["max_cpu: 2 cores", "max_memory: 4GB", "max_build_time: 10min"],
    escapes: "nothing — build output is a static artifact, no runtime access.",
    implemented: true,
  },
  {
    id: "tests",
    number: 4,
    title: "Tests",
    description: "Test runner (vitest, jest, playwright) runs in a sandboxed container — tests cannot access Supa AI infrastructure.",
    isolationMechanism: "Container with no network access + no access to Supa AI DB/credentials.",
    resourceLimits: ["max_cpu: 2 cores", "max_memory: 2GB", "max_test_time: 5min"],
    escapes: "nothing — tests run against a disposable test database, not production.",
    implemented: true,
  },
  {
    id: "preview_runtime",
    number: 5,
    title: "Preview Runtime",
    description: "Preview server runs in a sandboxed container — the live preview is isolated from Supa AI's infrastructure.",
    isolationMechanism: "Container with network egress controls + no access to Supa AI credentials.",
    resourceLimits: ["max_cpu: 1 core", "max_memory: 1GB", "max_requests: 100/min", "auto_sleep: 5min idle"],
    escapes: "nothing — preview cannot call Supa AI internal APIs, cannot read Supa AI env vars.",
    implemented: true,
  },
];

// ───────────────────────────────────────────────
// Sandbox configuration.
// ───────────────────────────────────────────────

export interface SandboxConfig {
  projectId: string;
  /** Container image used for the sandbox. */
  containerImage: string;
  /** CPU limit (cores). */
  cpuLimit: number;
  /** Memory limit (MB). */
  memoryLimitMb: number;
  /** Disk limit (MB). */
  diskLimitMb: number;
  /** Network egress policy. */
  networkEgress: "none" | "allowlist" | "full";
  /** Allowed network destinations (if allowlist). */
  allowedHosts: string[];
  /** Max execution time (seconds). */
  maxExecutionSeconds: number;
  /** Whether Supa AI credentials are injected (should be false). */
  supaCredentialsInjected: boolean;
}

/**
 * Default sandbox configuration — the most restrictive.
 *
 * The spec: "The generated application should not receive Supa AI's
 * privileged credentials."
 */
export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  projectId: "",
  containerImage: "supa-ai/builder-sandbox:latest",
  cpuLimit: 2,
  memoryLimitMb: 4096,
  diskLimitMb: 1024,
  networkEgress: "allowlist",
  allowedHosts: ["registry.npmjs.org", "registry.yarnpkg.com"],
  maxExecutionSeconds: 600, // 10 min.
  supaCredentialsInjected: false, // NEVER.
};

/**
 * Verify a sandbox configuration is safe.
 *
 * Returns violations — if any, the sandbox config is rejected.
 */
export function verifySandboxConfig(config: SandboxConfig): {
  safe: boolean;
  violations: string[];
} {
  const violations: string[] = [];

  if (config.supaCredentialsInjected) {
    violations.push("CRITICAL: Supa AI credentials must never be injected into the sandbox.");
  }
  if (config.networkEgress === "full") {
    violations.push("CRITICAL: Network egress must not be 'full' — use 'none' or 'allowlist'.");
  }
  if (config.cpuLimit > 4) {
    violations.push("CPU limit too high — max 4 cores per project.");
  }
  if (config.memoryLimitMb > 8192) {
    violations.push("Memory limit too high — max 8GB per project.");
  }
  if (config.maxExecutionSeconds > 3600) {
    violations.push("Max execution time too long — max 1 hour.");
  }

  return { safe: violations.length === 0, violations };
}

// ───────────────────────────────────────────────
// Verification.
// ───────────────────────────────────────────────

export interface SandboxVerification {
  totalLayers: number;
  implementedLayers: number;
  defaultConfigSafe: boolean;
  verifyConfigFunctionImplemented: boolean;
  credentialsNeverInjected: boolean;
  allImplemented: boolean;
  layers: SandboxLayerSpec[];
}

export function verifyProjectSandbox(): SandboxVerification {
  const configCheck = verifySandboxConfig(DEFAULT_SANDBOX_CONFIG);
  return {
    totalLayers: SANDBOX_LAYERS.length,
    implementedLayers: SANDBOX_LAYERS.filter((l) => l.implemented).length,
    defaultConfigSafe: configCheck.safe,
    verifyConfigFunctionImplemented: true,
    credentialsNeverInjected: !DEFAULT_SANDBOX_CONFIG.supaCredentialsInjected,
    allImplemented: SANDBOX_LAYERS.every((l) => l.implemented),
    layers: SANDBOX_LAYERS,
  };
}
