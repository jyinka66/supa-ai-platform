// Developer ecosystem — self-serve SDKs, sandboxes, docs, community.
//
// The spec (14.1): "The developer ecosystem is self-serve, self-paced,
// self-growing. Docs, SDKs, sandboxes, examples, tutorials, forums, and
// community — all self-serve. Support scales through community first, humans second."
//
// This module provides:
//   - generateSdk(type, lang) — auto-generated SDK bindings (TypeScript + Python).
//   - provisionSandbox(developerOrgId) — create an isolated sandbox for testing.
//   - getDeveloperStats(orgId) — installs, revenue, community stats.
//   - listAvailableSdkVersions — SDK versioning info.

import { db } from "@supa/db";
import { developerOrgs, marketplaceItems, toolRegistry } from "@supa/db/schema";
import { eq, and, sql, desc } from "drizzle-orm";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type SdkLanguage = "typescript" | "python";

export interface SdkInfo {
  language: SdkLanguage;
  version: string;
  packageUrl: string;     // npm or pypi URL.
  generatedAt: string;
  toolCount: number;
  connectorCount: number;
}

export interface Sandbox {
  id: string;
  developerOrgId: string;
  status: "active" | "expired" | "terminated";
  apiKey: string;
  rateLimitPerMin: number;
  budgetUsd: number;
  expiresAt: Date;
  createdAt: Date;
}

export interface DeveloperStats {
  orgId: string;
  orgName: string;
  reputation: number;
  verified: boolean;
  publishedItems: number;
  totalInstalls: number;
  totalRevenueUsd: number;
  avgRating: number;
  communityScore: number; // 0-100 (based on forum activity + help articles).
}

// ───────────────────────────────────────────────
// SDK generation — auto-generated from the tool registry + connectors.
// ───────────────────────────────────────────────

/**
 * Get SDK info for a language (version + tool/connector counts).
 */
export async function getSdkInfo(language: SdkLanguage): Promise<SdkInfo> {
  const toolCount = await db.execute(sql`select count(*)::integer as n from tool_registry where status = 'active'`);
  const connectorCount = await db.execute(sql`select count(*)::integer as n from connectors where status = 'active'`);

  const packageUrl = language === "typescript"
    ? "https://www.npmjs.com/package/@supa/sdk"
    : "https://pypi.org/project/supa-sdk/";

  return {
    language,
    version: "1.0.0",
    packageUrl,
    generatedAt: new Date().toISOString(),
    toolCount: Number((toolCount as unknown as Array<{ n: number }>)[0]?.n ?? 0),
    connectorCount: Number((connectorCount as unknown as Array<{ n: number }>)[0]?.n ?? 0),
  };
}

/**
 * List all available SDK versions.
 */
export async function listAvailableSdkVersions(): Promise<Array<{ language: SdkLanguage; version: string; isLatest: boolean }>> {
  return [
    { language: "typescript" as const, version: "1.0.0", isLatest: true },
    { language: "python" as const, version: "1.0.0", isLatest: true },
  ];
}

// ───────────────────────────────────────────────
// Sandbox provisioning — isolated testing environment for developers.
// ───────────────────────────────────────────────

const SANDBOX_TTL_HOURS = 24;
const SANDBOX_RATE_LIMIT = 60;
const SANDBOX_BUDGET_USD = 10;

/**
 * Provision a sandbox for a developer org.
 * The sandbox is an isolated environment with:
 *   - A test API key (rate-limited, budget-capped).
 *   - All active tools + connectors available.
 *   - 24-hour TTL (auto-expired).
 *
 * STUB: the real impl provisions an isolated namespace/container.
 */
export async function provisionSandbox(developerOrgId: string): Promise<Sandbox> {
  const apiKey = `sandbox_${developerOrgId}_${Date.now()}`;
  const expiresAt = new Date(Date.now() + SANDBOX_TTL_HOURS * 3600000);

  // STUB: the real impl would:
  //   1. Create an isolated namespace/container.
  //   2. Provision a test API key with rate limits + budget caps.
  //   3. Mount the tool registry + connectors.
  //   4. Set a TTL (auto-expiry after 24h).

  return {
    id: `sandbox-${developerOrgId}-${Date.now()}`,
    developerOrgId,
    status: "active",
    apiKey,
    rateLimitPerMin: SANDBOX_RATE_LIMIT,
    budgetUsd: SANDBOX_BUDGET_USD,
    expiresAt,
    createdAt: new Date(),
  };
}

// ───────────────────────────────────────────────
// Developer stats — installs, revenue, community.
// ───────────────────────────────────────────────

export async function getDeveloperStats(orgId: string): Promise<DeveloperStats | null> {
  const orgRows = await db
    .select()
    .from(developerOrgs)
    .where(eq(developerOrgs.id, orgId as any))
    .limit(1);
  const org = orgRows[0];
  if (!org) return null;

  const statsResult = await db.execute(sql`
    select
      count(*) filter (where status = 'published')::integer as published,
      coalesce(sum(install_count), 0)::integer as installs,
      coalesce(avg(rating_avg) filter (where rating_count > 0), 0)::numeric as avg_rating
    from marketplace_items
    where author_org_id = ${orgId}::uuid
  `);

  const stats = (statsResult as unknown as Array<{ published: number; installs: number; avg_rating: string }>)[0];

  return {
    orgId,
    orgName: org.name,
    reputation: Number(org.reputationScore),
    verified: org.verified,
    publishedItems: Number(stats?.published ?? 0),
    totalInstalls: Number(stats?.installs ?? 0),
    totalRevenueUsd: Number(org.totalRevenueUsd),
    avgRating: Number(stats?.avg_rating ?? 0),
    communityScore: 50, // stub — would compute from forum activity + help articles.
  };
}

// ───────────────────────────────────────────────
// Self-serve registration — create a developer org.
// ───────────────────────────────────────────────

export async function createDeveloperOrg(input: {
  slug: string;
  name: string;
  description?: string;
  ownerUserId: string;
}): Promise<{ id: string; slug: string; name: string }> {
  try {
    const rows = await db
      .insert(developerOrgs)
      .values({
        slug: input.slug,
        name: input.name,
        ...(input.description ? { description: input.description } : {}),
        ownerUserId: input.ownerUserId as any,
      })
      .returning({ id: developerOrgs.id, slug: developerOrgs.slug, name: developerOrgs.name });

    const row = rows[0];
    if (!row) throw new Error("org_insert_failed");

    return { id: row.id as string, slug: row.slug, name: row.name };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("unique") || msg.includes("23505")) {
      throw new Error("slug_already_exists");
    }
    throw err;
  }
}
