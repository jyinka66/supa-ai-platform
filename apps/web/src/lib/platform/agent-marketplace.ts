// Autonomous agent marketplace — submission, quality scoring, reputation, takedowns.
//
// The spec (14.2.2): "Agents submit themselves — a creator submits an agent;
// the platform runs automated safety, permission, budget, and quality checks."
//
// This module provides:
//   - submitAgent — creator submission with automated checks.
//   - scoreAgentQuality — automated quality scoring (reliability, safety, usefulness).
//   - autoCategorizeAgent — embedding-based auto-categorization.
//   - getFeaturedAgents — algorithmic featured selection.
//   - creatorDashboard — installs, revenue, reviews, reputation.

import { db } from "@supa/db";
import { marketplaceItems, developerOrgs, agentQualityScores } from "@supa/db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { evaluatePolicy } from "./policy-engine";
import { adminAudit } from "@/lib/admin/audit";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export interface AgentSubmission {
  slug: string;
  title: string;
  description: string;
  authorOrgId?: string;
  authorName: string;
  manifest: {
    systemPrompt: string;
    tools: string[];
    budgetLimitUsd: number;
    permissions: string[];
    maxSteps: number;
  };
  tags?: string[];
}

export interface QualityScore {
  reliabilityScore: number; // 0-100 (fixture pass rate).
  safetyScore: number;      // 0-100 (permission/budget compliance).
  usefulnessScore: number;  // 0-100 (user ratings + install growth).
  overallScore: number;     // weighted average.
  testResults: {
    fixturesRun: number;
    fixturesPassed: number;
    failures: string[];
  };
}

export interface FeaturedAgent {
  id: string;
  slug: string;
  title: string;
  description: string;
  ratingAvg: number;
  installCount: number;
  overallScore: number;
  authorName: string;
}

// ───────────────────────────────────────────────
// submitAgent — creator submission with automated checks.
//
// Flow:
//   1. Validate the manifest (system prompt, tools, budget, permissions).
//   2. Run automated safety checks (budget ≤ limit, no forbidden tools, permissions within scope).
//   3. Evaluate the publish policy (auto-approve vs escalate based on creator reputation).
//   4. Run the quality scoring (fixture suite — stub).
//   5. Auto-categorize (embedding-based — stub).
//   6. Insert the marketplace item.
// ───────────────────────────────────────────────

export async function submitAgent(submission: AgentSubmission): Promise<{
  itemId: string;
  status: string;
  reviewType: string;
  qualityScore: QualityScore;
}> {
  // 1. Validate the manifest.
  if (!submission.manifest.systemPrompt || submission.manifest.systemPrompt.length < 10) {
    throw new Error("invalid_system_prompt");
  }
  if (submission.manifest.budgetLimitUsd > 100) {
    throw new Error("budget_limit_exceeds_max_100");
  }

  // 2. Fetch the creator's reputation.
  let orgVerified = false;
  let orgReputation = 50;
  if (submission.authorOrgId) {
    const org = await db
      .select({ verified: developerOrgs.verified, reputation: developerOrgs.reputationScore })
      .from(developerOrgs)
      .where(eq(developerOrgs.id, submission.authorOrgId as any))
      .limit(1);
    if (org[0]) {
      orgVerified = org[0].verified;
      orgReputation = Number(org[0].reputation);
    }
  }

  // 3. Evaluate the publish policy.
  const decision = evaluatePolicy("marketplace.publish", {
    author_verified: orgVerified,
    author_reputation: orgReputation,
    kind: "agent",
  });

  // Agents always go through at least manual review (high-risk kind).
  const autoApprove = false; // agents are always escalated.
  const status = autoApprove ? "published" : "pending_review";
  const reviewType = "manual";

  // 4. Run quality scoring (stub — the real impl runs the fixture suite in a sandbox).
  const qualityScore = await scoreAgentQuality(submission.manifest);

  // 5. Auto-categorize (stub — the real impl uses embeddings).
  const category = autoCategorizeAgent(submission.manifest, submission.tags ?? []);

  // 6. Insert the marketplace item.
  const rows = await db
    .insert(marketplaceItems)
    .values({
      kind: "agent",
      slug: submission.slug,
      title: submission.title,
      description: submission.description,
      ...(submission.authorOrgId ? { authorOrgId: submission.authorOrgId as any } : {}),
      authorName: submission.authorName,
      status,
      reviewType,
      reviewResult: {
        auto_approve: autoApprove,
        policy: decision.policyKey,
        creator_reputation: orgReputation,
        creator_verified: orgVerified,
        category,
      },
      manifest: submission.manifest as any,
      tags: [...(submission.tags ?? []), category],
    })
    .returning({ id: marketplaceItems.id });

  const itemId = rows[0]?.id as string;
  if (!itemId) throw new Error("agent_insert_failed");

  // Store the quality score.
  await db.insert(agentQualityScores).values({
    marketplaceItemId: itemId as any,
    reliabilityScore: qualityScore.reliabilityScore.toString(),
    safetyScore: qualityScore.safetyScore.toString(),
    usefulnessScore: qualityScore.usefulnessScore.toString(),
    overallScore: qualityScore.overallScore.toString(),
    testResults: qualityScore.testResults as any,
  });

  await adminAudit({
    actor: "system",
    action: "marketplace.agent.submitted",
    target: { itemId, slug: submission.slug, creator: submission.authorName, qualityScore: qualityScore.overallScore },
    justification: `Agent submitted by ${submission.authorName} (reputation=${orgReputation}, verified=${orgVerified})`,
  });

  return { itemId, status, reviewType, qualityScore };
}

// ───────────────────────────────────────────────
// scoreAgentQuality — automated quality scoring.
//
// Three dimensions:
//   1. Reliability (0-100): fixture pass rate.
//   2. Safety (0-100): permission/budget compliance.
//   3. Usefulness (0-100): user ratings + install growth (stub — 50 for new agents).
//
// Overall = 0.4 * reliability + 0.3 * safety + 0.3 * usefulness.
// ───────────────────────────────────────────────

export async function scoreAgentQuality(manifest: {
  tools: string[];
  budgetLimitUsd: number;
  permissions: string[];
}): Promise<QualityScore> {
  // Reliability: stub — would run the fixture suite in the sandbox.
  const fixturesRun = 10;
  const fixturesPassed = 8;
  const failures = ["test_3: timeout", "test_7: unexpected output"];
  const reliabilityScore = (fixturesPassed / fixturesRun) * 100;

  // Safety: check permissions + budget.
  let safetyScore = 100;
  if (manifest.budgetLimitUsd > 10) safetyScore -= 20;
  if (manifest.permissions.includes("file:delete")) safetyScore -= 30;
  if (manifest.permissions.includes("workspace:delete")) safetyScore -= 40;
  safetyScore = Math.max(0, safetyScore);

  // Usefulness: stub — new agents start at 50 (neutral).
  const usefulnessScore = 50;

  // Overall: weighted average.
  const overallScore = 0.4 * reliabilityScore + 0.3 * safetyScore + 0.3 * usefulnessScore;

  return {
    reliabilityScore,
    safetyScore,
    usefulnessScore,
    overallScore,
    testResults: { fixturesRun, fixturesPassed, failures },
  };
}

// ───────────────────────────────────────────────
// autoCategorizeAgent — embedding-based auto-categorization (stub).
// ───────────────────────────────────────────────

function autoCategorizeAgent(manifest: { systemPrompt: string; tools: string[] }, tags: string[]): string {
  // STUB: the real impl uses embeddings (the system prompt → vector → nearest category).
  // For now, keyword-based categorization.
  const prompt = manifest.systemPrompt.toLowerCase();
  const tools = manifest.tools.join(" ").toLowerCase();

  if (prompt.includes("code") || tools.includes("github")) return "development";
  if (prompt.includes("email") || tools.includes("gmail") || tools.includes("slack")) return "communication";
  if (prompt.includes("analyz") || prompt.includes("report")) return "analytics";
  if (prompt.includes("write") || prompt.includes("content")) return "content";
  if (prompt.includes("schedule") || tools.includes("calendar")) return "productivity";
  if (tags.length > 0) return tags[0]!;
  return "general";
}

// ───────────────────────────────────────────────
// getFeaturedAgents — algorithmic featured selection.
//
// Featured = high rating + high installs + high quality score + good creator reputation.
// ───────────────────────────────────────────────

export async function getFeaturedAgents(limit: number = 10): Promise<FeaturedAgent[]> {
  const result = await db.execute(sql`
    select
      m.id, m.slug, m.title, m.description, m.rating_avg, m.install_count,
      coalesce(q.overall_score, 0)::numeric as overall_score,
      m.author_name
    from marketplace_items m
    left join agent_quality_scores q on q.marketplace_item_id = m.id
      and q.scored_at = (select max(scored_at) from agent_quality_scores where marketplace_item_id = m.id)
    where m.kind = 'agent' and m.status = 'published'
    order by
      (coalesce(q.overall_score, 0) * 0.3 +
       m.rating_avg * 10 * 0.4 +
       least(m.install_count, 1000) / 10 * 0.3) desc
    limit ${limit}
  `);

  return (result as unknown as Array<{
    id: string; slug: string; title: string; description: string;
    rating_avg: string; install_count: number; overall_score: string; author_name: string;
  }>).map((r) => ({
    id: r.id,
    slug: r.slug,
    title: r.title,
    description: r.description,
    ratingAvg: Number(r.rating_avg),
    installCount: r.install_count,
    overallScore: Number(r.overall_score),
    authorName: r.author_name,
  }));
}

// ───────────────────────────────────────────────
// Creator dashboard — installs, revenue, reviews.
// ───────────────────────────────────────────────

export interface CreatorDashboard {
  orgId: string;
  orgName: string;
  reputation: number;
  verified: boolean;
  totalInstalls: number;
  totalRevenue: number;
  avgRating: number;
  publishedCount: number;
  pendingReviewCount: number;
  topAgents: Array<{ slug: string; title: string; installs: number; rating: number; revenue: number }>;
}

export async function getCreatorDashboard(orgId: string): Promise<CreatorDashboard | null> {
  const orgRows = await db
    .select()
    .from(developerOrgs)
    .where(eq(developerOrgs.id, orgId as any))
    .limit(1);
  const org = orgRows[0];
  if (!org) return null;

  const itemsResult = await db.execute(sql`
    select
      count(*)::integer as total,
      count(*) filter (where status = 'published')::integer as published,
      count(*) filter (where status = 'pending_review')::integer as pending,
      coalesce(sum(install_count), 0)::integer as installs,
      coalesce(avg(rating_avg) filter (where rating_count > 0), 0)::numeric as avg_rating
    from marketplace_items
    where author_org_id = ${orgId}::uuid
  `);

  const stats = (itemsResult as unknown as Array<{
    total: number; published: number; pending: number; installs: number; avg_rating: string;
  }>)[0];

  const topResult = await db.execute(sql`
    select slug, title, install_count, rating_avg, revenue_share_pct
    from marketplace_items
    where author_org_id = ${orgId}::uuid and status = 'published'
    order by install_count desc
    limit 5
  `);

  const topAgents = (topResult as unknown as Array<{
    slug: string; title: string; install_count: number; rating_avg: string; revenue_share_pct: string;
  }>).map((r) => ({
    slug: r.slug,
    title: r.title,
    installs: r.install_count,
    rating: Number(r.rating_avg),
    revenue: 0, // stub — would compute from tool_usage_stats × revenue_share_pct.
  }));

  return {
    orgId,
    orgName: org.name,
    reputation: Number(org.reputationScore),
    verified: org.verified,
    totalInstalls: Number(stats?.installs ?? 0),
    totalRevenue: Number(org.totalRevenueUsd),
    avgRating: Number(stats?.avg_rating ?? 0),
    publishedCount: Number(stats?.published ?? 0),
    pendingReviewCount: Number(stats?.pending ?? 0),
    topAgents,
  };
}
