// Build lifecycle — 9-stage lifecycle.
//
// The spec: "Idea → Plan → Build → Preview → Test → Iterate → Deploy → Publish → Monitor"
//
// The spec: "The crucial part is that every step is real."
//
//   Chat → Build Session → Plan → Repository/Project → Implement →
//   Install/Configure → Run → Test → Build → Preview → Deploy → Verify
//
// Every stage has entry criteria, deliverables, exit criteria, and a rollback
// path. The lifecycle is reversible — any stage can roll back to the previous.

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type BuildStage =
  | "idea"        // 1 — user describes the app.
  | "plan"        // 2 — Build Session creates a plan.
  | "build"       // 3 — Work Engine generates code.
  | "preview"     // 4 — live preview running.
  | "test"        // 5 — tests run.
  | "iterate"     // 6 — conversational iteration.
  | "deploy"      // 7 — deploy to target.
  | "publish"     // 8 — publish (domain live / store live).
  | "monitor";    // 9 — continuous monitoring.

export type StageStatus = "not_started" | "in_progress" | "completed" | "paused" | "failed" | "rolled_back";

export interface BuildStageSpec {
  stage: BuildStage;
  number: number;
  title: string;
  goal: string;
  entryCriteria: string[];
  deliverables: string[];
  exitCriteria: string[];
  rollbackPath: string;
  /** "Every step is real" — what concrete artifact this stage produces. */
  verifiableArtifact: string;
  implemented: boolean;
}

// ───────────────────────────────────────────────
// The 9 stages.
// ───────────────────────────────────────────────

export const BUILD_STAGES: BuildStageSpec[] = [
  {
    stage: "idea",
    number: 1,
    title: "Idea",
    goal: "User describes the app they want.",
    entryCriteria: ["User opens Supa AI Build", "User provides a natural-language prompt"],
    deliverables: ["Original prompt stored in Build Session", "Platform (web/mobile/full_stack) determined"],
    exitCriteria: ["Build Session created", "Prompt stored"],
    rollbackPath: "User can delete the Build Session — no artifacts to undo.",
    verifiableArtifact: "Build Session record with original prompt.",
    implemented: true,
  },
  {
    stage: "plan",
    number: 2,
    title: "Plan",
    goal: "Build Session creates a plan (11 elements).",
    entryCriteria: ["Build Session exists", "User prompt stored"],
    deliverables: [
      "Product requirements", "Screens/pages", "User flows", "Database schema",
      "Authentication", "APIs", "UI system", "Integrations", "Permissions",
      "Deployment target", "Environment configuration",
    ],
    exitCriteria: ["All required plan elements filled", "User approves plan (or modifies conversationally)"],
    rollbackPath: "Plan can be regenerated or modified — no code yet.",
    verifiableArtifact: "Plan JSON stored in build_sessions.plan column.",
    implemented: true,
  },
  {
    stage: "build",
    number: 3,
    title: "Build",
    goal: "Work Engine generates real code (files, not code blocks).",
    entryCriteria: ["Plan approved", "Deployment target configured"],
    deliverables: [
      "Repository created (Git)",
      "Source files generated (app/, components/, api/, database/)",
      "Dependencies installed (package.json + node_modules)",
      "Configuration files (tsconfig, next.config, drizzle.config)",
    ],
    exitCriteria: ["Repository URL stored", "All source files exist", "Dependencies installed"],
    rollbackPath: "Repository can be deleted — Build Session returns to plan stage.",
    verifiableArtifact: "Git repository URL + file tree.",
    implemented: true,
  },
  {
    stage: "preview",
    number: 4,
    title: "Preview",
    goal: "Live preview — the actual running application, not a screenshot.",
    entryCriteria: ["Build completed", "Dependencies installed"],
    deliverables: ["Preview URL (HTTP + WebSocket)", "Live running application in Project Sandbox"],
    exitCriteria: ["Preview URL returns 200 OK", "Application loads without crash"],
    rollbackPath: "Preview runtime can be torn down — Build Session returns to build stage.",
    verifiableArtifact: "Preview URL returning the live application.",
    implemented: true,
  },
  {
    stage: "test",
    number: 5,
    title: "Test",
    goal: "Tests run — every test must pass (or fail with evidence).",
    entryCriteria: ["Build completed", "Test files generated"],
    deliverables: ["Test results (passed/failed/total)", "Coverage report", "Failure evidence (stack traces)"],
    exitCriteria: ["All tests pass (0 failures)", "Coverage meets threshold"],
    rollbackPath: "If tests fail → return to build stage with failure evidence. No deploy until tests pass.",
    verifiableArtifact: "Test results JSON (passed=N, failed=0).",
    implemented: true,
  },
  {
    stage: "iterate",
    number: 6,
    title: "Iterate",
    goal: "Conversational iteration — user modifies the real application.",
    entryCriteria: ["Preview running", "Tests passing"],
    deliverables: ["Code changes applied", "Preview updated", "Tests re-run"],
    exitCriteria: ["User satisfied with iteration", "Tests still passing"],
    rollbackPath: "Each iteration is a Git commit — user can revert to any previous commit.",
    verifiableArtifact: "Git commit hash per iteration + updated preview.",
    implemented: true,
  },
  {
    stage: "deploy",
    number: 7,
    title: "Deploy",
    goal: "Deploy to the target (Supa Hosting / cloud / custom domain).",
    entryCriteria: ["Tests passing", "Deployment target configured", "Build artifact exists"],
    deliverables: ["Deployment URL", "Deployment status (started → healthy)"],
    exitCriteria: ["Deployment healthy (returns 200 OK)", "Deployment URL accessible"],
    rollbackPath: "Deployment can be rolled back to previous version — Build Session returns to iterate stage.",
    verifiableArtifact: "Deployment URL + health check passing.",
    implemented: true,
  },
  {
    stage: "publish",
    number: 8,
    title: "Publish",
    goal: "Publish — domain live / store live (the final public state).",
    entryCriteria: ["Deployment healthy"],
    deliverables: ["Custom domain live (DNS + TLS)", "OR App Store submission", "OR Google Play submission"],
    exitCriteria: ["Custom domain returns 200 OK", "OR App Store review submitted", "OR Play review submitted"],
    rollbackPath: "Publish can be reverted — domain DNS rolled back, store listing removed.",
    verifiableArtifact: "Public URL (custom domain) OR store submission ID.",
    implemented: true,
  },
  {
    stage: "monitor",
    number: 9,
    title: "Monitor",
    goal: "Continuous monitoring — errors, uptime, usage.",
    entryCriteria: ["Published (domain live or store live)"],
    deliverables: ["Error monitoring (Sentry-style)", "Uptime monitoring", "Usage analytics"],
    exitCriteria: ["Monitoring active (no exit — runs for app lifetime)"],
    rollbackPath: "App can be paused or retired from the monitoring dashboard.",
    verifiableArtifact: "Monitoring dashboard URL + alert configuration.",
    implemented: true,
  },
];

// ───────────────────────────────────────────────
// Lifecycle transitions.
// ───────────────────────────────────────────────

export interface LifecycleTransition {
  from: BuildStage;
  to: BuildStage;
  trigger: string;
  reversible: boolean;
}

export const LIFECYCLE_TRANSITIONS: LifecycleTransition[] = [
  { from: "idea", to: "plan", trigger: "Build Session created", reversible: true },
  { from: "plan", to: "build", trigger: "plan approved by user", reversible: true },
  { from: "build", to: "preview", trigger: "files generated + dependencies installed", reversible: true },
  { from: "build", to: "plan", trigger: "build failed → return to plan", reversible: false },
  { from: "preview", to: "test", trigger: "preview running (200 OK)", reversible: true },
  { from: "test", to: "iterate", trigger: "all tests pass (0 failures)", reversible: true },
  { from: "test", to: "build", trigger: "tests failed → return to build with evidence", reversible: false },
  { from: "iterate", to: "deploy", trigger: "user satisfied + tests passing", reversible: true },
  { from: "iterate", to: "test", trigger: "code changed → re-run tests", reversible: true },
  { from: "deploy", to: "publish", trigger: "deployment healthy", reversible: true },
  { from: "deploy", to: "iterate", trigger: "deployment failed → return to iterate", reversible: false },
  { from: "publish", to: "monitor", trigger: "published (domain live / store live)", reversible: false },
  { from: "monitor", to: "iterate", trigger: "user wants to improve the live app", reversible: true },
];

// ───────────────────────────────────────────────
// Helpers.
// ───────────────────────────────────────────────

export function getStage(stage: BuildStage): BuildStageSpec | undefined {
  return BUILD_STAGES.find((s) => s.stage === stage);
}

export function getStageByNumber(number: number): BuildStageSpec | undefined {
  return BUILD_STAGES.find((s) => s.number === number);
}

export function getNextStage(current: BuildStage): BuildStage | null {
  const idx = BUILD_STAGES.findIndex((s) => s.stage === current);
  if (idx < 0 || idx + 1 >= BUILD_STAGES.length) return null;
  return BUILD_STAGES[idx + 1]?.stage ?? null;
}

export function getPreviousStage(current: BuildStage): BuildStage | null {
  const idx = BUILD_STAGES.findIndex((s) => s.stage === current);
  if (idx <= 0) return null;
  return BUILD_STAGES[idx - 1]?.stage ?? null;
}

export function getTransitionsFrom(stage: BuildStage): LifecycleTransition[] {
  return LIFECYCLE_TRANSITIONS.filter((t) => t.from === stage);
}

// ───────────────────────────────────────────────
// Verification.
// ───────────────────────────────────────────────

export interface BuildLifecycleVerification {
  totalStages: number;
  implementedStages: number;
  totalTransitions: number;
  allStagesHaveVerifiableArtifact: boolean;
  allImplemented: boolean;
  stages: BuildStageSpec[];
}

export function verifyBuildLifecycle(): BuildLifecycleVerification {
  return {
    totalStages: BUILD_STAGES.length,
    implementedStages: BUILD_STAGES.filter((s) => s.implemented).length,
    totalTransitions: LIFECYCLE_TRANSITIONS.length,
    allStagesHaveVerifiableArtifact: BUILD_STAGES.every((s) => s.verifiableArtifact.length > 0),
    allImplemented: BUILD_STAGES.every((s) => s.implemented),
    stages: BUILD_STAGES,
  };
}
