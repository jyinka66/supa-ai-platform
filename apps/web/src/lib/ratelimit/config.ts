/**
 * Rate-limit tier definitions.
 *
 * Two layers (per the sliding-window design):
 *   - STRICT tiers: provider-calling routes (chat, feedback) — expensive,
 *     so limits are tight.
 *   - LOOSE tiers: everything else — abuse protection only.
 *
 * The `default` tier applies when a route doesn't specify one.
 */

export const TIERS = {
  // ============ Strict (cost protection) ============
  // These call LLM providers — each request costs real money.
  chat: { limit: 20, windowMs: 60_000 }, // 20 messages/min per user
  feedback: { limit: 30, windowMs: 60_000 }, // 30 feedback submissions/min

  // ============ Supa OS — expensive operations ============
  // Build creation triggers the full agent pipeline (architect + security + UIUX + fullstack + QA).
  supaOsBuild: { limit: 10, windowMs: 60_000 }, // 10 build creations/min per admin.
  // Deploy + publish are irreversible + cost cloud-provider fees.
  supaOsDeploy: { limit: 5, windowMs: 60_000 }, // 5 deploys/min per admin.
  supaOsPublish: { limit: 3, windowMs: 60_000 }, // 3 publishes/min per admin.
  // Sandbox file writes — 60/min (reasonable for a coding session).
  supaOsSandbox: { limit: 60, windowMs: 60_000 },
  // WASM command execution — 30/min (commands can be long-running).
  supaOsWasm: { limit: 30, windowMs: 60_000 },

  // ============ Governance — destructive actions ============
  // Kill switch activation — 2/min (cooling-off prevents accidental flip-flops).
  governanceKillSwitch: { limit: 2, windowMs: 60_000 },
  // Committee decisions — 10/min.
  governanceCommittee: { limit: 10, windowMs: 60_000 },
  // Decision log queries — 30/min (heavier queries).
  governanceQuery: { limit: 30, windowMs: 60_000 },

  // ============ Expansion — long-running pipeline operations ============
  // Detection + evaluation are expensive (DB-heavy).
  expansionPipeline: { limit: 10, windowMs: 60_000 },
  // Optimization implementation — 5/min (mutations).
  expansionOptimization: { limit: 5, windowMs: 60_000 },

  // ============ Loose (abuse protection) ============
  // Public routes — generous but capped to prevent scraping.
  share: { limit: 120, windowMs: 60_000 }, // 120 share-link views/min

  // Auth routes — tight to prevent brute-force.
  authActions: { limit: 5, windowMs: 300_000 }, // 5 attempts / 5 min (login/signup/reset)

  // Everything else.
  default: { limit: 100, windowMs: 60_000 }, // 100 API calls/min
} as const;

export type TierName = keyof typeof TIERS;

/**
 * Returns the tier config by name, falling back to `default`.
 */
export function getTier(name: TierName | string | undefined) {
  if (name && name in TIERS) {
    return TIERS[name as TierName];
  }
  return TIERS.default;
}

/**
 * Maps a route path to its rate-limit tier.
 * Used by middleware to apply limits without each route needing to call
 * `rateLimit()` explicitly.
 *
 * Routes not listed here use the `default` tier.
 */
export const ROUTE_TIERS: Record<string, TierName> = {
  // Strict (cost protection)
  "/api/chat/stream": "chat",
  "/api/chat/complete": "chat",
  "/api/messages/[id]/feedback": "feedback",

  // Public (abuse protection)
  "/api/share/[token]": "share",

  // Auth (brute-force guard)
  "/api/auth/signup": "authActions",
  "/api/auth/login": "authActions",
  "/api/auth/reset": "authActions",
  "/api/auth/otp": "authActions",
  "/api/auth/magic-link": "authActions",
  "/api/auth/invite-accept": "authActions",

  // Supa OS — expensive operations
  "/api/supa-os/build": "supaOsBuild", // POST — create new build
  "/api/supa-os/build/[id]/deploy": "supaOsDeploy",
  "/api/supa-os/build/[id]/sandbox/files": "supaOsSandbox",
  "/api/supa-os/build/[id]/sandbox/terminal": "supaOsSandbox",
  "/api/supa-os/build/[id]/sandbox/self-heal": "supaOsSandbox",
  "/api/supa-os/build/[id]/agents/[role]": "supaOsBuild",
  "/api/supa-os/build/[id]/inspector": "supaOsBuild",
  "/api/supa-os/wasm/execute": "supaOsWasm",
  "/api/supa-os/loan/calculate": "supaOsSandbox",
  "/api/supa-os/ledger/post": "supaOsDeploy",
  "/api/supa-os/compliance/encrypt": "supaOsSandbox",
  "/api/supa-os/compliance/mask": "supaOsSandbox",
  "/api/supa-os/marketplace": "supaOsBuild",
  "/api/supa-os/marketplace/[itemId]/review": "supaOsPublish",

  // Builder — mutating actions
  "/api/builder/sessions/[id]/publish": "supaOsPublish",
  "/api/builder/sessions/[id]/export": "supaOsDeploy",
  "/api/builder/sessions/[id]/handoff": "supaOsDeploy",
  "/api/builder/sessions/[id]/versions/rollback": "supaOsDeploy",
  "/api/builder/sessions/[id]/lifecycle": "supaOsDeploy",
  "/api/builder/sessions/[id]/preview": "supaOsSandbox",
  "/api/builder/sessions/[id]/preview/[action]": "supaOsSandbox",

  // Governance — destructive actions
  "/api/governance/kill-switches/[id]/trigger": "governanceKillSwitch",
  "/api/governance/circuit-breakers/[id]": "governanceKillSwitch",
  "/api/governance/committee/decisions": "governanceCommittee",
  "/api/governance/decisions/log": "governanceQuery",
  "/api/governance/audit": "governanceQuery",
  "/api/governance/transparency": "governanceQuery",
  "/api/governance/rollback": "governanceKillSwitch",
  "/api/governance/developer-abuse": "governanceCommittee",
  "/api/governance/delegations": "governanceCommittee",
  "/api/governance/delegations/[id]/revoke": "governanceKillSwitch",

  // Expansion — pipeline operations
  "/api/expansion/detection": "expansionPipeline",
  "/api/expansion/evaluation": "expansionPipeline",
  "/api/expansion/prioritization": "expansionPipeline",
  "/api/expansion/preparation": "expansionPipeline",
  "/api/expansion/verification": "expansionPipeline",
  "/api/expansion/soft-launch": "expansionPipeline",
  "/api/expansion/optimization": "expansionOptimization",
};

/**
 * Returns the tier for a given route path.
 * Matches the longest prefix (so `/api/chat/stream` matches before `/api`).
 */
export function getTierForRoute(pathname: string): TierName {
  // Try exact match first.
  if (ROUTE_TIERS[pathname]) {
    return ROUTE_TIERS[pathname];
  }

  // Try prefix match (longest first).
  const sorted = Object.keys(ROUTE_TIERS).sort((a, b) => b.length - a.length);
  for (const route of sorted) {
    // Handle dynamic segments: /api/messages/[id]/feedback should match
    // /api/messages/abc-123/feedback
    const pattern = route.replace(/\[.+?\]/g, "[^/]+");
    const regex = new RegExp(`^${pattern}$`);
    if (regex.test(pathname)) {
      return ROUTE_TIERS[route]!;
    }
  }

  return "default";
}

export { rateLimit, checkTwoTierLimits, type RateResult } from "./sliding-window";
