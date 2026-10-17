// Supa OS API client — typed wrappers for the 98 backend routes.
//
// All methods return Promise<T> where T is the typed response shape.
// Errors are thrown as ApiClientError with the right status code + message.
//
// Usage:
//   ```
//   "use client";
//   import { supaOsApi } from "@/lib/api-client";
//
//   const { session } = await supaOsApi.build.create({
//     prompt: "Build a todo app with Next.js + Supabase",
//   });
//   ```

"use client";

// ───────────────────────────────────────────────
// Types — mirror the backend zod schemas.
// ───────────────────────────────────────────────

export interface BuildSession {
  id: string;
  ownerId: string;
  wsId: string;
  name: string;
  originalPrompt: string;
  platform: "web" | "mobile" | "full_stack";
  status: "planning" | "building" | "testing" | "previewing" | "deployed" | "published" | "monitoring" | "paused" | "failed" | "archived";
  plan: Record<string, unknown>;
  repoUrl: string | null;
  buildArtifactHash: string | null;
  testResults: { passed: number; failed: number; total: number } | null;
  previewUrl: string | null;
  deploymentTarget: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ParsedGoal {
  domain: string;
  compliance: string[];
  platforms: string[];
}

export interface OrchestrationPlan {
  steps: Array<{ role: string; task: string }>;
}

export interface CreateBuildResponse {
  session: BuildSession;
  parsedGoal: ParsedGoal;
  orchestrationPlan: OrchestrationPlan;
  reasoning: unknown;
  kernel: unknown;
}

export interface SandboxFile {
  path: string;
  content: string;
  updatedAt: string;
}

export interface SandboxState {
  sessionId: string;
  files: SandboxFile[];
  terminal: {
    lines: Array<{ seq: number; stream: "stdout" | "stderr" | "system"; content: string; timestamp: string }>;
  };
}

export interface LoanSchedule {
  schedule: Array<{ month: number; payment: number; principal: number; interest: number; balance: number }>;
}

export interface LoanSummary {
  principal: number;
  annualInterestRate: number;
  termMonths: number;
  monthlyPayment: number;
  totalPayment: number;
  totalInterest: number;
  effectiveRate: number;
  lastPaymentDate: string | null;
}

export interface MarketplaceItem {
  id: string;
  name: string;
  type: "agent_skill" | "api_connector" | "ui_component" | "template" | "theme";
  description: string;
  creatorId: string;
  creatorName: string;
  status: "draft" | "submitted" | "in_review" | "approved" | "rejected" | "published" | "deprecated" | "removed" | "yanked";
  monetization: "free" | "one_time" | "subscription" | "revenue_share";
  price: number;
  version: string;
  tags: string[];
  manifest?: Record<string, unknown>;
  downloadCount: number;
  rating: number;
  reviewCount: number;
  featured: boolean;
  verified: boolean;
  publishedAt: string | null;
}

export interface GovernanceDecision {
  decision: "auto_approved" | "policy_approved" | "human_approved" | "blocked" | "deferred";
  riskLevel: "low" | "medium" | "high" | "critical" | "irreversible";
  policyKey: string | null;
  reasoning: Record<string, unknown>;
  decisionId: string;
}

export interface KillSwitch {
  id: string;
  key: string;
  scopeType: string;
  isActive: boolean;
  activatedAt: string | null;
  activatedBy: string | null;
  activationReason: string | null;
  autoDeactivateAt: string | null;
}

export interface CircuitBreaker {
  spec: { type: string; title: string; description: string; unit: string };
  state: "closed" | "open" | "half_open";
}

export interface AuditEntry {
  id: string;
  category: string;
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  wsId: string | null;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface ExpansionPipeline {
  stages: string[];
  autonomyLevels: Array<{ stage: string; level: string }>;
  humanCheckpoints: Array<{ id: string; title: string; stage: string }>;
}

// ───────────────────────────────────────────────
// Error class
// ───────────────────────────────────────────────

export class ApiClientError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

// ───────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  // Use an absolute URL when running in the browser (relative URLs work in
  // fetch in the browser but not in test environments like jsdom).
  const url = path.startsWith("http") ? path : path; // browsers handle relative paths fine
  const res = await fetch(url, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
    credentials: "include",
  });

  if (!res.ok) {
    let code = "INTERNAL_ERROR";
    let message = `Request failed with status ${res.status}`;
    let details: unknown;
    try {
      const body = await res.json();
      if (body?.error?.code) code = body.error.code;
      if (body?.error?.message) message = body.error.message;
      if (body?.error?.details) details = body.error.details;
    } catch {
      // not JSON — fall back to defaults.
    }
    throw new ApiClientError(message, res.status, code, details);
  }

  const json = await res.json();
  return (json as { data: T }).data;
}

// ───────────────────────────────────────────────
// API namespaces
// ───────────────────────────────────────────────

export const supaOsApi = {
  build: {
    create: (body: { prompt: string; platform?: "web" | "mobile" | "full_stack"; workspaceId?: string }) =>
      request<CreateBuildResponse>("/api/supa-os/build", { method: "POST", body }),

    get: (id: string) =>
      request<{ session: BuildSession; deployState: unknown; verifiableArtifact: unknown }>(`/api/supa-os/build/${id}`),

    cancel: (id: string) =>
      request<{ sessionId: string; status: string }>(`/api/supa-os/build/${id}`, { method: "DELETE" }),

    runAgent: (id: string, role: "architect" | "security" | "uiux" | "fullstack" | "qa") =>
      request<{ sessionId: string; role: string; output: unknown }>(`/api/supa-os/build/${id}/agents/${role}`, { method: "POST" }),

    deploy: (id: string, target: string) =>
      request<{ deployment: unknown; history: unknown }>(`/api/supa-os/build/${id}/deploy`, { method: "POST", body: { target } }),

    selfHeal: (id: string, body: { output: string[]; source: string }) =>
      request<{ selfHealingLoop: unknown }>(`/api/supa-os/build/${id}/sandbox/self-heal`, { method: "POST", body }),

    inspect: (id: string, prompt: string, targetNodeId?: string | null) =>
      request<{ edit: unknown }>(`/api/supa-os/build/${id}/inspector`, { method: "POST", body: { prompt, targetNodeId } }),
  },

  sandbox: {
    get: (buildId: string) =>
      request<SandboxState>(`/api/supa-os/build/${buildId}/sandbox`),

    mountFiles: (buildId: string, files: Array<{ path: string; content: string }>) =>
      request<{ mounted: number; files: SandboxFile[] }>(`/api/supa-os/build/${buildId}/sandbox`, { method: "POST", body: { files } }),

    writeFile: (buildId: string, path: string, content: string) =>
      request<{ path: string; bytes: number }>(`/api/supa-os/build/${buildId}/sandbox/files`, { method: "POST", body: { path, content } }),

    deleteFile: (buildId: string, path: string) =>
      request<{ deleted: string }>(`/api/supa-os/build/${buildId}/sandbox?path=${encodeURIComponent(path)}`, { method: "DELETE" }),

    appendTerminal: (buildId: string, body: { stream: "stdout" | "stderr"; content: string; source?: string }) =>
      request<{ terminal: unknown }>(`/api/supa-os/build/${buildId}/sandbox/terminal`, { method: "POST", body }),
  },

  preview: {
    start: (buildId: string) =>
      request<{ preview: { port: number; status: string; url: string } }>(`/api/supa-os/build/${buildId}/preview`, { method: "POST" }),

    stop: (buildId: string) =>
      request<{ stopped: boolean }>(`/api/supa-os/build/${buildId}/preview`, { method: "DELETE" }),

    action: (buildId: string, action: "sleep" | "wake" | "restart") =>
      request<{ preview: unknown }>(`/api/supa-os/build/${buildId}/preview/${action}`, { method: "POST" }),
  },

  catalog: {
    stacks: () => request<{ stacks: Array<{ id: string; label: string }> }>("/api/supa-os/catalog/stacks"),
    cloudTargets: () => request<{ targets: unknown[]; total: number }>("/api/supa-os/catalog/cloud-targets"),
    kycProviders: () => request<{ providers: unknown[]; africanProviders: unknown[] }>("/api/supa-os/catalog/kyc-providers"),
    paymentGateways: () => request<{ gateways: unknown[] }>("/api/supa-os/catalog/payment-gateways"),
    enterpriseTiers: () => request<{ tiers: unknown[]; deploymentModels: unknown[] }>("/api/supa-os/catalog/enterprise-tiers"),
    sdkEndpoints: () => request<{ endpoints: unknown[]; sdks: unknown[] }>("/api/supa-os/catalog/sdk-endpoints"),
    onPrem: () => request<{ privateCloudTargets: unknown[]; containerPlatforms: unknown[] }>("/api/supa-os/catalog/on-prem"),
  },

  loan: {
    calculate: (body: { principal: number; annualInterestRate: number; termMonths: number; startDate?: string }) =>
      request<{ schedule: LoanSchedule; summary: LoanSummary }>("/api/supa-os/loan/calculate", { method: "POST", body }),
  },

  marketplace: {
    list: (query?: { q?: string; type?: string; sort?: string }) => {
      const params = new URLSearchParams();
      if (query?.q) params.set("q", query.q);
      if (query?.type) params.set("type", query.type);
      if (query?.sort) params.set("sort", query.sort);
      const qs = params.toString();
      return request<{ items: MarketplaceItem[]; total: number }>(`/api/supa-os/marketplace${qs ? `?${qs}` : ""}`);
    },
    createDeveloperOrg: (body: { slug: string; name: string; description?: string }) =>
      request<{ organization: { id: string; slug: string; name: string } }>("/api/supa-os/marketplace/developer-orgs", { method: "POST", body }),
    get: (itemId: string) => request<{ item: MarketplaceItem }>(`/api/supa-os/marketplace/${encodeURIComponent(itemId)}`),
    download: (itemId: string) => request<{ item: MarketplaceItem; downloadedAt: string }>(`/api/supa-os/marketplace/${encodeURIComponent(itemId)}/download`, { method: "POST" }),
    submit: (body: { developerOrgId?: string; name: string; type: string; description: string; monetization: string; price: number; version: string; tags?: string[]; manifest: Record<string, unknown> }) =>
      request<{ item: MarketplaceItem; checks: unknown[] }>("/api/supa-os/marketplace", { method: "POST", body }),
    review: (itemId: string, body: { decision: "approve" | "reject"; notes: string }) =>
      request<{ item: MarketplaceItem }>(`/api/supa-os/marketplace/${itemId}/review`, { method: "POST", body }),
  },

  compliance: {
    encrypt: (body: { value: string; fieldType: string }) =>
      request<{ encrypted: string; iv: string; tag: string }>("/api/supa-os/compliance/encrypt", { method: "POST", body }),
    mask: (body: { value: string; fieldType: string }) =>
      request<{ masked: string }>("/api/supa-os/compliance/mask", { method: "POST", body }),
  },

  wasm: {
    execute: (body: { command: string; cwd?: string; env?: Record<string, string>; autoTriggered?: boolean; language?: "nodejs" | "python" | "go" | "rust" | "deno" | "bun" | "postgres"; timeoutMs?: number; files?: Array<{ path: string; content: string }> }) =>
      request<{ command: unknown; success: boolean; runtime: string; availableRuntimes: string[] }>("/api/supa-os/wasm/execute", { method: "POST", body }),
  },

  systemPrompt: {
    get: () =>
      request<{ mission: unknown; reasoningPhases: unknown[]; outputRules: unknown[]; prohibitedPatterns: unknown[] }>("/api/supa-os/system-prompt"),
  },
};

export const governanceApi = {
  decisions: {
    route: (body: { actionType: string; targetType: string; targetId: string; actorId: string; costUsd?: number }) =>
      request<{ decision: GovernanceDecision }>(`/api/governance/decisions`, { method: "POST", body }),
  },
  killSwitches: {
    list: () =>
      request<{ switches: KillSwitch[]; types: unknown[]; propagationSlaSeconds: number }>("/api/governance/kill-switches"),
    trigger: (id: string, body: { reason: string; autoDeactivateInHours?: number }) =>
      request<{ activation: unknown }>(`/api/governance/kill-switches/${id}/trigger`, { method: "POST", body }),
  },
  circuitBreakers: {
    list: () =>
      request<{ breakers: CircuitBreaker[]; total: number; openBreakers: number }>("/api/governance/circuit-breakers"),
  },
  audit: {
    list: (query?: { category?: string; actor?: string; limit?: number }) => {
      const params = new URLSearchParams();
      if (query?.category) params.set("category", query.category);
      if (query?.actor) params.set("actor", query.actor);
      if (query?.limit) params.set("limit", String(query.limit));
      const qs = params.toString();
      return request<{ entries: AuditEntry[]; total: number }>(`/api/governance/audit${qs ? `?${qs}` : ""}`);
    },
  },
  transparency: {
    list: (query: { userId?: string; wsId?: string; limit?: number }) => {
      const params = new URLSearchParams();
      if (query.userId) params.set("userId", query.userId);
      if (query.wsId) params.set("wsId", query.wsId);
      if (query.limit) params.set("limit", String(query.limit));
      return request<{ entries: unknown[] }>(`/api/governance/transparency?${params}`);
    },
  },
  metrics: {
    get: () =>
      request<{ governance: unknown; policy: unknown; reputation: unknown }>("/api/governance/metrics"),
  },
};

export const expansionApi = {
  pipeline: {
    get: () =>
      request<ExpansionPipeline>("/api/expansion/pipeline"),
  },
  detection: {
    run: (body: { regionCode: string; windowDays?: number; regionType?: string }) =>
      request<{ bundle: unknown; queueEntry: unknown }>(`/api/expansion/detection`, { method: "POST", body }),
  },
  evaluation: {
    run: (body: { regionCode: string; includeLanguageReadiness?: boolean; includePaymentReadiness?: boolean }) =>
      request<{ marketFit: unknown; languageReadiness: unknown; paymentReadiness: unknown }>(`/api/expansion/evaluation`, { method: "POST", body }),
  },
  monitoring: {
    get: () =>
      request<{ metricGroups: unknown[]; alertTypes: unknown[] }>("/api/expansion/monitoring"),
  },
  success: {
    measure: (regionCode: string) =>
      request<{ measurement: unknown }>(`/api/expansion/success?regionCode=${regionCode}`),
  },
};

export const builderApi = {
  sessions: {
    list: (query?: { ownerId?: string; status?: string; page?: number; pageSize?: number }) => {
      const params = new URLSearchParams();
      if (query?.ownerId) params.set("ownerId", query.ownerId);
      if (query?.status) params.set("status", query.status);
      if (query?.page) params.set("page", String(query.page));
      if (query?.pageSize) params.set("pageSize", String(query.pageSize));
      const qs = params.toString();
      return request<{ sessions: BuildSession[]; total: number }>(`/api/builder/sessions${qs ? `?${qs}` : ""}`);
    },
    get: (id: string) =>
      request<{ session: BuildSession }>(`/api/builder/sessions/${id}`),
    updatePlan: (id: string, body: { plan: Record<string, unknown>; reason: string }) =>
      request<{ updatedKeys: string[] }>(`/api/builder/sessions/${id}/plan`, { method: "PATCH", body }),
    advance: (id: string, body: { action: "advance" | "pause" | "resume" | "rollback"; targetStage?: string; reason: string }) =>
      request<{ newStatus: string }>(`/api/builder/sessions/${id}/lifecycle`, { method: "POST", body }),
    publish: (id: string, target: string) =>
      request<{ result: unknown }>(`/api/builder/sessions/${id}/publish`, { method: "POST", body: { target } }),
    export: (id: string) =>
      request<{ result: unknown }>(`/api/builder/sessions/${id}/export`, { method: "POST" }),
  },
};

// ───────────────────────────────────────────────
// Freelancer API
// ───────────────────────────────────────────────

export interface RepurposedVariant {
  platform: string;
  content: string;
  charCount: number;
  withinLimit: boolean;
  hashtags?: string[];
  label: string;
  description: string;
}

export const freelancerApi = {
  jobs: {
    match: (body: {
      jobs: Array<{ jobId: string; title: string; description: string; budget: { amount: number; currency: string }; platform: string; clientRating?: number; clientVerifiedPayment?: boolean; clientLocation?: string }>;
      portfolio: Array<{ portfolioId: string; sourceText: string; title: string; tags?: string[] }>;
      filters?: Record<string, unknown>;
    }) =>
      request<{ matchedJobs: unknown[]; totalJobs: number; matched: number }>("/api/freelancer/jobs/match", { method: "POST", body }),
  },
  content: {
    repurpose: (body: {
      sourceContent: string;
      sourceType: "blog_post" | "video_transcript" | "podcast_transcript" | "article" | "product_description";
      platforms: string[];
      tone?: "professional" | "casual" | "bold" | "educational" | "playful";
      language?: string;
    }) =>
      request<{ variants: RepurposedVariant[]; extractedKeyPoints: string[]; platformLimits: Record<string, number> }>("/api/freelancer/content/repurpose", { method: "POST", body }),
  },
  approve: (body: {
    proposalId: string; jobId: string; jobTitle: string; platform: string;
    proposal: Record<string, unknown>; evaluation: Record<string, unknown>;
    channel: "slack" | "telegram"; callbackUrl: string;
  }) =>
    request<{ message: unknown; proposalId: string; sentTo: string }>("/api/freelancer/approve", { method: "POST", body }),
  analytics: (body: { bids: unknown[] }) =>
    request<{ analytics: unknown }>("/api/freelancer/analytics", { method: "POST", body }),
};
