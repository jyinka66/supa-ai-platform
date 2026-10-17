/**
 * @supa/security/boundary-5-platform
 * ----------------------------------------------------------------
 * Threat boundary 5: the platform seams.
 *
 *   - Multi-tenancy in storage: every relational query is scoped
 *     by account_id at the repository layer (enforced by a lint
 *     rule: no raw table access outside repositories); doc
 *     snapshots and op-log archives carry owner ids and are
 *     checked at read, not trust-at-write.
 *
 *   - SSRF: AI gateway and render workers fetch URLs (remote images
 *     in repaint, asset pipelines) → egress proxy with IP-literal
 *     blocking (no RFC1918/link-local/metadata endpoints —
 *     169.254.169.254 is the classic cloud kill), DNS-rebinding
 *     protection (resolve-then-connect on the pinned IP),
 *     redirect caps.
 *
 *   - Secrets: provider keys live in a secrets manager, never in
 *     env files on pods; ai-gateway is the only service holding AI
 *     provider credentials (single choke point again).
 *
 *   - Supply chain: lockfiles + provenance-verified publishes for
 *     the monorepo; dependencies reviewed on addition, automated
 *     CVE scan in CI with a fail-on-critical gate (same discipline
 *     as budgets).
 *
 *   - Abuse: credit ledger doubles as abuse telemetry (pass 1's
 *     anomaly alerts); account-level AI spend caps with soft-
 *     degrade, not hard failure, for genuine heavy users.
 * ----------------------------------------------------------------
 */

// ───────────────────────────────────────────────
// Multi-tenancy: repository-scoped account_id
// ───────────────────────────────────────────────

/**
 * Every relational query MUST be scoped by account_id at the
 * repository layer. This is enforced by a lint rule: no raw table
 * access outside repositories. The contract is captured here so
 * both the lint rule and the repository implementations reference
 * the same source of truth.
 *
 * The lint rule greps for direct `db.<table>` access outside
 * `packages/db/src/repositories/` and fails CI if it finds any.
 * Repositories themselves MUST accept an `accountId` parameter and
 * include it in every WHERE clause.
 */
export const REPOSITORY_PATH_GLOB = "packages/db/src/repositories/**/*.ts";

export const LINT_RULE_NO_RAW_ACCESS = {
  rule: "no-raw-table-access-outside-repositories",
  description:
    "Raw table access (db.<table>) is forbidden outside packages/db/src/repositories/. " +
    "All multi-tenant queries must go through a repository that scopes by account_id.",
  forbidden: [
    "db.select().from(<table>)",
    "db.insert(<table>)",
    "db.update(<table>)",
    "db.delete().from(<table>)",
  ],
  allowlist: [REPOSITORY_PATH_GLOB],
};

/**
 * Doc snapshots and op-log archives carry owner ids. They're
 * checked at READ, not trust-at-write — even if an attacker
 * somehow writes a snapshot with the wrong owner, the read path
 * rejects the fetch.
 *
 * The contract: every stored artifact has an `ownerAccountId` field
 * that the fetch path checks against the requester's cap.
 */
export interface OwnedArtifact {
  /** Owner account id (set at write, checked at read). */
  ownerAccountId: string;
  /** Artifact hash (for dedupe + addressing). */
  artifactHash: string;
  /** When the artifact was created. */
  createdAt: number;
}

/**
 * Authorize an artifact fetch. The requester must hold a cap on
 * the artifact (which proves their account was granted access by
 * the owner). The owner check is redundant with the cap check —
 * defense in depth.
 */
export interface ArtifactFetchAuthz {
  requesterAccountId: string;
  artifact: OwnedArtifact;
  /** Has the requester been granted a cap on this artifact? */
  hasCap: boolean;
}

export function authorizeArtifactFetch(authz: ArtifactFetchAuthz): boolean {
  if (authz.hasCap) return true;
  // Owner can always fetch their own artifacts.
  return authz.requesterAccountId === authz.artifact.ownerAccountId;
}

// ───────────────────────────────────────────────
// SSRF egress proxy
// ───────────────────────────────────────────────

/**
 * The AI gateway and render workers fetch URLs (remote images in
 * repaint, asset pipelines). The egress proxy blocks IP-literal
 * endpoints that would reach internal networks:
 *
 *   - RFC1918 private ranges (10/8, 172.16/12, 192.168/16)
 *   - Link-local (169.254/16) — including 169.254.169.254 (cloud metadata)
 *   - Loopback (127/8)
 *   - IPv6 loopback (::1) and link-local (fe80::/10)
 *   - Unique local (fc00::/7)
 *   - IPv4-mapped IPv6 (::ffff:<above>)
 *
 * DNS-rebinding protection: resolve-then-connect. The proxy resolves
 * the hostname, picks the IP, and connects to that IP (not a fresh
 * resolution at connect time). The check runs on the resolved IP,
 * not the hostname — an attacker can't bypass by resolving to
 * 169.254.169.254 mid-connection.
 *
 * Redirect caps: HTTP redirects are followed by the proxy (not the
 * caller), with a max of 3 hops, and each hop re-runs the IP check.
 */
export interface EgressProxyConfig {
  /** Max HTTP redirect hops (default 3). */
  maxRedirects: number;
  /** Connect timeout (ms). */
  connectTimeoutMs: number;
  /** Read timeout (ms). */
  readTimeoutMs: number;
  /** Max response size (bytes). */
  maxResponseBytes: number;
}

export const DEFAULT_EGRESS_CONFIG: EgressProxyConfig = {
  maxRedirects: 3,
  connectTimeoutMs: 5_000,
  readTimeoutMs: 30_000,
  maxResponseBytes: 50 * 1024 * 1024, // 50 MiB
};

export interface BlockedIpResult {
  blocked: boolean;
  reason?: string;
}

/**
 * Check whether an IP address is in a blocked range.
 * Accepts both IPv4 and IPv6 (including IPv4-mapped IPv6).
 *
 * Node's URL parser converts IPv4-mapped IPv6 in dotted-quad form
 * (`::ffff:169.254.169.254`) to compressed hex (`::ffff:a9fe:a9fe`).
 * We handle both forms — the dotted-quad form via regex, and the
 * compressed hex form by parsing the last two 16-bit groups back
 * to dotted-quad.
 */
export function isBlockedIp(ip: string): BlockedIpResult {
  // Normalize IPv4-mapped IPv6 dotted-quad form (::ffff:a.b.c.d) to IPv4.
  const dottedMatch = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (dottedMatch) {
    return isBlockedIpv4(dottedMatch[1]!);
  }
  // Normalize IPv4-mapped IPv6 compressed-hex form (::ffff:XXYY:XXYY).
  // Node's URL parser emits this for IPv6 literals in URLs.
  const hexMatch = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hexMatch) {
    const g1 = parseInt(hexMatch[1]!, 16);
    const g2 = parseInt(hexMatch[2]!, 16);
    const a = (g1 >> 8) & 0xff;
    const b = g1 & 0xff;
    const c = (g2 >> 8) & 0xff;
    const d = g2 & 0xff;
    return isBlockedIpv4(`${a}.${b}.${c}.${d}`);
  }
  // Plain IPv4.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    return isBlockedIpv4(ip);
  }
  // IPv6 (non-mapped).
  return isBlockedIpv6(ip);
}

function isBlockedIpv4(ip: string): BlockedIpResult {
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return { blocked: true, reason: `malformed IPv4: ${ip}` };
  }
  const [a, b] = parts;
  // 127/8 — loopback
  if (a === 127) return { blocked: true, reason: `loopback: ${ip}` };
  // 10/8 — RFC1918
  if (a === 10) return { blocked: true, reason: `RFC1918: ${ip}` };
  // 172.16/12 — RFC1918
  if (a === 172 && b! >= 16 && b! <= 31) {
    return { blocked: true, reason: `RFC1918: ${ip}` };
  }
  // 192.168/16 — RFC1918
  if (a === 192 && b === 168) return { blocked: true, reason: `RFC1918: ${ip}` };
  // 169.254/16 — link-local (includes 169.254.169.254 cloud metadata)
  if (a === 169 && b === 254) {
    return { blocked: true, reason: `link-local (metadata endpoint?): ${ip}` };
  }
  // 0/8 — "this host"
  if (a === 0) return { blocked: true, reason: `0/8: ${ip}` };
  // 100.64/10 — CGNAT
  if (a === 100 && b! >= 64 && b! <= 127) {
    return { blocked: true, reason: `CGNAT: ${ip}` };
  }
  return { blocked: false };
}

function isBlockedIpv6(ip: string): BlockedIpResult {
  const lower = ip.toLowerCase();
  // ::1 — loopback
  if (lower === "::1") return { blocked: true, reason: `IPv6 loopback: ${ip}` };
  // fe80::/10 — link-local
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
    return { blocked: true, reason: `IPv6 link-local: ${ip}` };
  }
  // fc00::/7 — unique local
  if (lower.startsWith("fc") || lower.startsWith("fd")) {
    return { blocked: true, reason: `IPv6 unique-local: ${ip}` };
  }
  return { blocked: false };
}

/**
 * URL pre-check: reject obviously-blocked schemes + IP literals in
 * the hostname. The full check runs after DNS resolution.
 */
export function preCheckUrl(url: string): BlockedIpResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { blocked: true, reason: "malformed URL" };
  }
  // Scheme allowlist — only https.
  if (parsed.protocol !== "https:") {
    return { blocked: true, reason: `scheme ${parsed.protocol} not allowed (https only)` };
  }
  // If hostname is an IP literal, check it directly.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (/^[\d.]+$/.test(hostname) || hostname.includes(":")) {
    return isBlockedIp(hostname);
  }
  // Reject obvious metadata hostnames (defense in depth — DNS could
  // resolve these to internal IPs; the post-resolution check catches
  // the actual IP, but this catches naming-based attacks too).
  const blockedHostnames = ["metadata.google.internal", "metadata.aws.internal"];
  if (blockedHostnames.includes(hostname)) {
    return { blocked: true, reason: `metadata hostname: ${hostname}` };
  }
  return { blocked: false };
}

// ───────────────────────────────────────────────
// Secrets: secrets manager contract
// ───────────────────────────────────────────────

/**
 * Provider keys live in a secrets manager (Vault, AWS Secrets
 * Manager, GCP Secret Manager), never in env files on pods. The
 * ai-gateway is the ONLY service holding AI provider credentials —
 * single choke point again.
 *
 * This interface is the contract; the implementation is provided by
 * the host process. Tests use `InMemorySecretsManager`.
 */
export interface SecretsManager {
  /** Fetch a secret by key. Throws if not found. */
  fetch(key: string): Promise<string>;
  /** Fetch multiple secrets at once (for cold-start loading). */
  fetchBatch(keys: readonly string[]): Promise<Record<string, string>>;
}

export class InMemorySecretsManager implements SecretsManager {
  constructor(private readonly secrets: Record<string, string>) {}

  async fetch(key: string): Promise<string> {
    if (!(key in this.secrets)) {
      throw new Error(`secret not found: ${key}`);
    }
    return this.secrets[key]!;
  }

  async fetchBatch(keys: readonly string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const k of keys) {
      out[k] = await this.fetch(k);
    }
    return out;
  }
}

/**
 * The single-choke-point contract: only the ai-gateway holds AI
 * provider credentials. Other services MUST NOT have these env vars
 * or secrets mounted. The deployment manifests (infra/k8s/) enforce
 * this by only mounting the secrets into the ai-gateway pod.
 */
export const AI_PROVIDER_SECRET_KEYS = [
  "GROQ_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

export const EXPORT_URL_SECRET_KEY = "EXPORT_URL_SECRET";

export const JWT_SECRET_KEY = "JWT_SECRET";

// ───────────────────────────────────────────────
// Supply chain: lockfiles + provenance + CVE scan
// ───────────────────────────────────────────────

/**
 * Dependencies reviewed on addition. Automated CVE scan in CI with
 * a fail-on-critical gate — same discipline as budgets.
 *
 * The gate runs `pnpm audit --audit-level=critical` and fails CI if
 * any critical CVE is found in the dependency tree. The
 * `provenance-verified publishes` rule means published packages
 * must carry provenance attestations (SLSA Level 3+); pnpm verifies
 * these on install.
 */
export interface SupplyChainGateConfig {
  /** Fail CI on critical CVEs. */
  failOnCriticalCve: boolean;
  /** Fail CI on high CVEs (stricter — opt-in). */
  failOnHighCve: boolean;
  /** Require provenance attestations on publish. */
  requireProvenance: boolean;
  /** Max age of a lockfile before forced refresh (days). */
  maxLockfileAgeDays: number;
}

export const DEFAULT_SUPPLY_CHAIN_CONFIG: SupplyChainGateConfig = {
  failOnCriticalCve: true,
  failOnHighCve: false, // opt-in for stricter teams
  requireProvenance: true,
  maxLockfileAgeDays: 30,
};

export interface CveScanResult {
  critical: number;
  high: number;
  moderate: number;
  low: number;
  /** Cves by package: { [pkg]: [{ id, severity, fixVersion? }] } */
  byPackage: Record<string, { id: string; severity: "critical" | "high" | "moderate" | "low"; fixVersion?: string }[]>;
}

export function evaluateSupplyChainGate(
  scan: CveScanResult,
  config: SupplyChainGateConfig = DEFAULT_SUPPLY_CHAIN_CONFIG,
): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (config.failOnCriticalCve && scan.critical > 0) {
    reasons.push(`${scan.critical} critical CVE(s) found — fail-on-critical gate`);
  }
  if (config.failOnHighCve && scan.high > 0) {
    reasons.push(`${scan.high} high CVE(s) found — fail-on-high gate`);
  }
  return { passed: reasons.length === 0, reasons };
}

// ───────────────────────────────────────────────
// Abuse: credit-ledger-as-telemetry + soft-degrade
// ───────────────────────────────────────────────

/**
 * The credit ledger doubles as abuse telemetry: anomalous spend
 * patterns surface in the cost-model's alerting (pass 1). Account-
 * level AI spend caps trigger SOFT-DEGRADE — not hard failure — so
 * genuine heavy users aren't cut off; they're routed to cheaper
 * models until the next billing cycle.
 *
 * Soft-degrade routing: when an account crosses the soft cap, the
 * ai-gateway routes all subsequent requests to the cheapest tier in
 * the fallback chain, regardless of op class. Hard cap (rare; only
 * for confirmed abuse) is a 429.
 */
export interface AccountSpendState {
  accountId: string;
  /** Spend so far in the current billing cycle (USD). */
  spendUsd: number;
  /** Soft cap (USD) — past this, downgrade to cheap models. */
  softCapUsd: number;
  /** Hard cap (USD) — past this, 429. */
  hardCapUsd: number;
}

export type SpendDecision =
  | { kind: "allow" }
  | { kind: "soft-degrade"; reason: string; downgradeTo: "cheap" }
  | { kind: "hard-block"; reason: string; retryAfterMs: number };

export function evaluateSpendCap(state: AccountSpendState): SpendDecision {
  if (state.spendUsd >= state.hardCapUsd) {
    return {
      kind: "hard-block",
      reason: `account spend $${state.spendUsd.toFixed(2)} crossed hard cap $${state.hardCapUsd.toFixed(2)} — confirmed abuse or runaway`,
      retryAfterMs: 60_000, // back off 1 min
    };
  }
  if (state.spendUsd >= state.softCapUsd) {
    return {
      kind: "soft-degrade",
      reason: `account spend $${state.spendUsd.toFixed(2)} crossed soft cap $${state.softCapUsd.toFixed(2)} — downgrading to cheap tier`,
      downgradeTo: "cheap",
    };
  }
  return { kind: "allow" };
}

/**
 * Soft-degrade router: rewrites the fallback chain to start at the
 * cheapest tier when an account is in soft-degrade. The chain is
 * still walked (cheap → degrade to manual), so soft-degrade users
 * get the cheap model + manual fallback, not nothing.
 */
export function applySoftDegradeToFallbackChain(
  chain: { tier: "cheap" | "standard" | "premium" }[],
  decision: SpendDecision,
): { tier: "cheap" | "standard" | "premium" }[] {
  if (decision.kind !== "soft-degrade") return chain;
  // Filter to cheap-only, preserving order.
  const cheap = chain.filter((c) => c.tier === "cheap");
  if (cheap.length === 0) {
    // No cheap option in chain — return the original (caller will
    // hit the degrade-to-manual sentinel).
    return chain;
  }
  return cheap;
}
