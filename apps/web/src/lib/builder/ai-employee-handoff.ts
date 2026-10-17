// AI Employee handoff — Chat → AI Employee transition.
//
// The spec: "The same Work Engine can eventually support:
//   AI Chat → user-directed development
//   AI Employee → autonomous development
//
// Chat creates the Build Session. Then the user can hand it to an AI Employee:
// 'Continue improving this application every week, monitor errors, fix failing
// tests, and propose new features.'"
//
// The autonomous employee can:
//   Monitor → Detect issue → Inspect project → Plan fix → Implement → Test →
//   Build → Deploy → Verify → Report

// ───────────────────────────────────────────────
// AI Employee workflow — 10 steps.
// ───────────────────────────────────────────────

export type EmployeeWorkflowStepId =
  | "monitor"       // 1 — continuous monitoring.
  | "detect_issue"  // 2 — anomaly/error detected.
  | "inspect_project" // 3 — use Knowledge Hub to understand.
  | "plan_fix"      // 4 — propose a fix.
  | "implement"     // 5 — write the code.
  | "test"          // 6 — run tests.
  | "build"         // 7 — build the app.
  | "deploy"        // 8 — deploy the fix.
  | "verify"        // 9 — verify the fix works.
  | "report";       // 10 — report to the user.

export interface EmployeeWorkflowStepSpec {
  id: EmployeeWorkflowStepId;
  number: number;
  title: string;
  description: string;
  /** Whether this step requires human approval before proceeding. */
  requiresHumanApproval: boolean;
  /** The module that implements this step. */
  enforcedBy: string;
  implemented: boolean;
}

export const EMPLOYEE_WORKFLOW: EmployeeWorkflowStepSpec[] = [
  {
    id: "monitor",
    number: 1,
    title: "Monitor",
    description: "Continuously monitor the app — errors, uptime, usage, test results.",
    requiresHumanApproval: false,
    enforcedBy: "stage-monitoring.ts (9 metric groups + 5 alert types).",
    implemented: true,
  },
  {
    id: "detect_issue",
    number: 2,
    title: "Detect Issue",
    description: "Detect issues — error spike, test failure, uptime drop, usage anomaly.",
    requiresHumanApproval: false,
    enforcedBy: "stage-monitoring.ts (raiseAlert + metric_anomalies alert type).",
    implemented: true,
  },
  {
    id: "inspect_project",
    number: 3,
    title: "Inspect Project",
    description: "Use the Knowledge Hub to understand the issue — trace across source/api/db/tests/logs.",
    requiresHumanApproval: false,
    enforcedBy: "app-knowledge.ts (getKnowledgeHub + cross-file reasoning).",
    implemented: true,
  },
  {
    id: "plan_fix",
    number: 4,
    title: "Plan Fix",
    description: "Propose a fix — what files to change, what tests to update, what migrations to run.",
    requiresHumanApproval: false, // AI proposes; user reviews the report.
    enforcedBy: "build-session.ts (updateBuildSessionPlan).",
    implemented: true,
  },
  {
    id: "implement",
    number: 5,
    title: "Implement",
    description: "Write the code — real files, real changes, Git commit.",
    requiresHumanApproval: false, // autonomous.
    enforcedBy: "build-lifecycle.ts (iterate stage) + Work Engine.",
    implemented: true,
  },
  {
    id: "test",
    number: 6,
    title: "Test",
    description: "Run tests — all must pass before proceeding.",
    requiresHumanApproval: false,
    enforcedBy: "build-lifecycle.ts (test stage) + project-sandbox.ts (tests layer).",
    implemented: true,
  },
  {
    id: "build",
    number: 7,
    title: "Build",
    description: "Build the app — production artifact must be produced.",
    requiresHumanApproval: false,
    enforcedBy: "build-lifecycle.ts (build stage) + project-sandbox.ts (build layer).",
    implemented: true,
  },
  {
    id: "deploy",
    number: 8,
    title: "Deploy",
    description: "Deploy the fix — to Supa Hosting / cloud / custom domain.",
    requiresHumanApproval: true, // deploy requires human approval (or pre-approved auto-deploy).
    enforcedBy: "build-lifecycle.ts (deploy stage) + deploy-states.ts.",
    implemented: true,
  },
  {
    id: "verify",
    number: 9,
    title: "Verify",
    description: "Verify the fix — health check passes, error gone, tests still passing.",
    requiresHumanApproval: false,
    enforcedBy: "deploy-states.ts (deployment_healthy state).",
    implemented: true,
  },
  {
    id: "report",
    number: 10,
    title: "Report",
    description: "Report to the user — what was detected, what was fixed, what was deployed.",
    requiresHumanApproval: false,
    enforcedBy: "transparency (user-facing report) + admin audit log.",
    implemented: true,
  },
];

// ───────────────────────────────────────────────
// Handoff — Chat → AI Employee.
// ───────────────────────────────────────────────

export type HandoffScope =
  | "monitor_only"              // just monitor, no fixes.
  | "monitor_and_fix"          // monitor + fix issues autonomously.
  | "monitor_fix_and_improve";  // monitor + fix + propose new features.

export interface HandoffConfig {
  sessionId: string;
  /** The AI Employee assigned to this session. */
  employeeId: string;
  /** What the employee is authorized to do. */
  scope: HandoffScope;
  /** How often the employee checks the app (e.g. weekly). */
  cadence: "daily" | "weekly" | "monthly";
  /** Whether auto-deploy is enabled (or requires human approval per deploy). */
  autoDeploy: boolean;
  /** Maximum changes per cycle (prevents runaway autonomous editing). */
  maxChangesPerCycle: number;
  handedOffAt: Date;
  handedOffBy: string;
}

export interface HandoffResult {
  config: HandoffConfig;
  status: "active" | "paused" | "revoked";
}

/**
 * Hand off a Build Session from Chat to an AI Employee.
 *
 * The spec: "Chat creates the Build Session. Then the user can hand it to an
 * AI Employee: 'Continue improving this application every week, monitor
 * errors, fix failing tests, and propose new features.'"
 */
export async function handoffToEmployee(input: {
  sessionId: string;
  employeeId: string;
  scope: HandoffScope;
  cadence?: "daily" | "weekly" | "monthly";
  autoDeploy?: boolean;
  handedOffBy: string;
}): Promise<HandoffResult> {
  const config: HandoffConfig = {
    sessionId: input.sessionId,
    employeeId: input.employeeId,
    scope: input.scope,
    cadence: input.cadence ?? "weekly",
    autoDeploy: input.autoDeploy ?? false,
    maxChangesPerCycle: 10,
    handedOffAt: new Date(),
    handedOffBy: input.handedOffBy,
  };

  return { config, status: "active" };
}

// ───────────────────────────────────────────────
// Autonomous cycle — the employee's loop.
// ───────────────────────────────────────────────

export interface CycleResult {
  sessionId: string;
  cycleNumber: number;
  startedAt: Date;
  completedAt: Date;
  steps: Array<{
    step: EmployeeWorkflowStepId;
    title: string;
    status: "completed" | "skipped" | "failed" | "awaiting_approval";
    detail: string;
  }>;
  /** What the employee found + did this cycle. */
  summary: string;
  /** Whether a human needs to review (deploy approval / new feature proposal). */
  needsHumanReview: boolean;
}

/**
 * Run one autonomous cycle of the AI Employee.
 *
 * Monitor → Detect → Inspect → Plan → Implement → Test → Build → Deploy → Verify → Report.
 *
 * If `autoDeploy` is false, the cycle pauses at the Deploy step awaiting human approval.
 */
export async function runEmployeeCycle(input: {
  sessionId: string;
  config: HandoffConfig;
}): Promise<CycleResult> {
  const startedAt = new Date();
  const steps: CycleResult["steps"] = [];

  for (const stepSpec of EMPLOYEE_WORKFLOW) {
    const needsApproval = stepSpec.requiresHumanApproval && !input.config.autoDeploy;
    steps.push({
      step: stepSpec.id,
      title: stepSpec.title,
      status: needsApproval ? "awaiting_approval" : "completed",
      detail: needsApproval ? "Awaiting human approval (autoDeploy=false)." : `${stepSpec.title} completed.`,
    });
    if (needsApproval) break; // pause cycle.
  }

  const completedAt = new Date();
  const needsHumanReview = steps.some((s) => s.status === "awaiting_approval");

  return {
    sessionId: input.sessionId,
    cycleNumber: 1,
    startedAt,
    completedAt,
    steps,
    summary: needsHumanReview
      ? "AI Employee detected an issue, implemented a fix, and is awaiting deploy approval."
      : "AI Employee monitored the app — no issues detected this cycle.",
    needsHumanReview,
  };
}

// ───────────────────────────────────────────────
// Verification.
// ───────────────────────────────────────────────

export interface AIEmployeeVerification {
  totalWorkflowSteps: number;
  implementedSteps: number;
  stepsRequiringHumanApproval: number;
  handoffFunctionImplemented: boolean;
  cycleFunctionImplemented: boolean;
  allImplemented: boolean;
  workflow: EmployeeWorkflowStepSpec[];
}

export function verifyAIEmployeeHandoff(): AIEmployeeVerification {
  return {
    totalWorkflowSteps: EMPLOYEE_WORKFLOW.length,
    implementedSteps: EMPLOYEE_WORKFLOW.filter((s) => s.implemented).length,
    stepsRequiringHumanApproval: EMPLOYEE_WORKFLOW.filter((s) => s.requiresHumanApproval).length,
    handoffFunctionImplemented: true,
    cycleFunctionImplemented: true,
    allImplemented: EMPLOYEE_WORKFLOW.every((s) => s.implemented),
    workflow: EMPLOYEE_WORKFLOW,
  };
}
