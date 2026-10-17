// Performance budgets — per page / endpoint / AI call / background job.
//
// The spec: "Performance budgets and monitoring — per page (LCP, FID, CLS,
// TTFB, JS, CSS, image), per API endpoint, per AI call, per background job.
// Enforced in CI."
//
// Budgets are defined here (the source of truth). A CI checker validates
// that the actual bundle sizes / measured latencies are within budget.
// Regressions block merges.
//
// Budget categories:
//   1. Page budgets — LCP, FID, CLS, TTFB + asset sizes (JS, CSS, image).
//   2. API endpoint budgets — p95 latency targets per route.
//   3. AI call budgets — first-token p95 + total duration p95 per provider.
//   4. Background job budgets — p95 duration per job type.

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export interface PageBudget {
  path: string; // e.g. '/', '/dashboard', '/chat/[id]'
  lcpMs: number; // Largest Contentful Paint.
  fidMs: number; // First Input Delay (or INP).
  cls: number;   // Cumulative Layout Shift.
  ttfbMs: number; // Time to First Byte.
  jsKb: number;  // JS bundle size.
  cssKb: number; // CSS bundle size.
  imageKb: number; // Total image weight.
}

export interface EndpointBudget {
  method: string;
  path: string; // e.g. 'GET /api/v1/chat/threads'
  p95Ms: number;
  p99Ms: number;
}

export interface AiCallBudget {
  provider: string;
  model: string;
  firstTokenP95Ms: number;
  totalP95Ms: number;
}

export interface JobBudget {
  jobType: string;
  p95Ms: number;
}

export interface BudgetSet {
  pages: PageBudget[];
  endpoints: EndpointBudget[];
  aiCalls: AiCallBudget[];
  jobs: JobBudget[];
}

// ───────────────────────────────────────────────
// Budget definitions (the source of truth — enforced in CI)
// ───────────────────────────────────────────────

export const PAGE_BUDGETS: PageBudget[] = [
  { path: "/",                lcpMs: 2500, fidMs: 100, cls: 0.1, ttfbMs: 600, jsKb: 170, cssKb: 30, imageKb: 200 },
  { path: "/dashboard",        lcpMs: 2500, fidMs: 100, cls: 0.1, ttfbMs: 600, jsKb: 250, cssKb: 40, imageKb: 300 },
  { path: "/chat/[id]",        lcpMs: 3000, fidMs: 200, cls: 0.1, ttfbMs: 600, jsKb: 300, cssKb: 40, imageKb: 100 },
  { path: "/work",             lcpMs: 3000, fidMs: 200, cls: 0.1, ttfbMs: 600, jsKb: 300, cssKb: 40, imageKb: 100 },
  { path: "/settings",         lcpMs: 2500, fidMs: 100, cls: 0.1, ttfbMs: 600, jsKb: 200, cssKb: 30, imageKb: 50 },
  { path: "/admin",             lcpMs: 3000, fidMs: 200, cls: 0.1, ttfbMs: 800, jsKb: 400, cssKb: 50, imageKb: 50 },
];

export const ENDPOINT_BUDGETS: EndpointBudget[] = [
  { method: "GET",  path: "GET /api/v1/chat/threads",            p95Ms: 200,  p99Ms: 500 },
  { method: "POST", path: "POST /api/v1/chat/threads/:id/messages", p95Ms: 300, p99Ms: 800 },
  { method: "GET",  path: "GET /api/v1/work/items",               p95Ms: 200,  p99Ms: 500 },
  { method: "POST", path: "POST /api/v1/work/items",              p95Ms: 300,  p99Ms: 800 },
  { method: "GET",  path: "GET /api/v1/files/download",            p95Ms: 150,  p99Ms: 400 },
  { method: "POST", path: "POST /api/v1/files/:id/share",          p95Ms: 200,  p99Ms: 500 },
  { method: "GET",  path: "GET /api/shares/:token",                p95Ms: 100,  p99Ms: 300 },
  { method: "POST", path: "POST /api/v1/auth/login",               p95Ms: 300,  p99Ms: 800 },
  { method: "POST", path: "POST /api/v1/auth/refresh",             p95Ms: 100,  p99Ms: 300 },
  { method: "POST", path: "POST /api/admin/login",                 p95Ms: 500,  p99Ms: 1500 },
];

export const AI_CALL_BUDGETS: AiCallBudget[] = [
  { provider: "openai",    model: "gpt-4o",          firstTokenP95Ms: 500,  totalP95Ms: 5000 },
  { provider: "openai",    model: "gpt-4o-mini",      firstTokenP95Ms: 400,  totalP95Ms: 3000 },
  { provider: "anthropic", model: "claude-3-5-sonnet", firstTokenP95Ms: 500, totalP95Ms: 5000 },
  { provider: "anthropic", model: "claude-3-5-haiku",  firstTokenP95Ms: 400, totalP95Ms: 3000 },
];

export const JOB_BUDGETS: JobBudget[] = [
  { jobType: "chat.complete",     p95Ms: 10000 },
  { jobType: "pdf.generate",      p95Ms: 20000 },
  { jobType: "image.process",     p95Ms: 5000 },
  { jobType: "email.send",        p95Ms: 3000 },
  { jobType: "webhook.deliver",   p95Ms: 5000 },
  { jobType: "agent.run",          p95Ms: 30000 },
  { jobType: "workspace.purge",    p95Ms: 30000 },
  { jobType: "slo.snapshot",       p95Ms: 5000 },
];

export const BUDGETS: BudgetSet = {
  pages: PAGE_BUDGETS,
  endpoints: ENDPOINT_BUDGETS,
  aiCalls: AI_CALL_BUDGETS,
  jobs: JOB_BUDGETS,
};

// ───────────────────────────────────────────────
// Budget checker (for CI)
// ───────────────────────────────────────────────

export interface BudgetViolation {
  category: "page" | "endpoint" | "ai_call" | "job";
  name: string;
  metric: string;
  budget: number;
  actual: number;
  unit: string;
  overByPct: number; // (actual - budget) / budget * 100.
}

/**
 * Check measured values against budgets. Returns violations (empty = pass).
 *
 * Usage in CI:
 *   const violations = checkBudgets(measured);
 *   if (violations.length > 0) {
 *     console.error(JSON.stringify(violations, null, 2));
 *     process.exit(1); // block the merge.
 *   }
 */
export function checkPageBudgets(measured: Partial<PageBudget>[]): BudgetViolation[] {
  const violations: BudgetViolation[] = [];
  for (const m of measured) {
    if (!m.path) continue;
    const budget = PAGE_BUDGETS.find((b) => b.path === m.path);
    if (!budget) continue;

    if (m.lcpMs !== undefined && m.lcpMs > budget.lcpMs) {
      violations.push(makeViolation("page", m.path, "lcpMs", budget.lcpMs, m.lcpMs, "ms"));
    }
    if (m.fidMs !== undefined && m.fidMs > budget.fidMs) {
      violations.push(makeViolation("page", m.path, "fidMs", budget.fidMs, m.fidMs, "ms"));
    }
    if (m.cls !== undefined && m.cls > budget.cls) {
      violations.push(makeViolation("page", m.path, "cls", budget.cls, m.cls, ""));
    }
    if (m.ttfbMs !== undefined && m.ttfbMs > budget.ttfbMs) {
      violations.push(makeViolation("page", m.path, "ttfbMs", budget.ttfbMs, m.ttfbMs, "ms"));
    }
    if (m.jsKb !== undefined && m.jsKb > budget.jsKb) {
      violations.push(makeViolation("page", m.path, "jsKb", budget.jsKb, m.jsKb, "kb"));
    }
    if (m.cssKb !== undefined && m.cssKb > budget.cssKb) {
      violations.push(makeViolation("page", m.path, "cssKb", budget.cssKb, m.cssKb, "kb"));
    }
    if (m.imageKb !== undefined && m.imageKb > budget.imageKb) {
      violations.push(makeViolation("page", m.path, "imageKb", budget.imageKb, m.imageKb, "kb"));
    }
  }
  return violations;
}

export function checkEndpointBudgets(measured: Partial<EndpointBudget>[]): BudgetViolation[] {
  const violations: BudgetViolation[] = [];
  for (const m of measured) {
    if (!m.path) continue;
    const budget = ENDPOINT_BUDGETS.find((b) => b.path === m.path);
    if (!budget) continue;
    if (m.p95Ms !== undefined && m.p95Ms > budget.p95Ms) {
      violations.push(makeViolation("endpoint", m.path, "p95Ms", budget.p95Ms, m.p95Ms, "ms"));
    }
    if (m.p99Ms !== undefined && m.p99Ms > budget.p99Ms) {
      violations.push(makeViolation("endpoint", m.path, "p99Ms", budget.p99Ms, m.p99Ms, "ms"));
    }
  }
  return violations;
}

function makeViolation(
  category: BudgetViolation["category"],
  name: string,
  metric: string,
  budget: number,
  actual: number,
  unit: string,
): BudgetViolation {
  return {
    category,
    name,
    metric,
    budget,
    actual,
    unit,
    overByPct: ((actual - budget) / budget) * 100,
  };
}

// ───────────────────────────────────────────────
// Acceptance criteria (from the spec)
// ───────────────────────────────────────────────

export const ACCEPTANCE_CRITERIA = {
  lighthousePerformance: 90,   // >= 90 on landing pages.
  apiP95Ms: 300,               // < 300ms across all endpoints.
  aiFirstTokenP95Ms: 500,      // < 500ms.
  jobP95Ms: 30_000,            // < 30s.
  loadTestMultiplier: 10,      // pass at 10x current traffic.
  errorBudgetAlertThreshold: 0.5, // alert at 50% consumption.
} as const;
