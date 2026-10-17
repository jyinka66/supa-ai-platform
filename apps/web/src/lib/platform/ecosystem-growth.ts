// Autonomous ecosystem growth — developer/creator/partner/vertical/regional/enterprise/community.
// 14.2.19: "Developer growth — sandbox onboarding, tutorials, docs, community, office
// hours all self-serve. Creator growth — marketplace onboarding, revenue dashboards."

import { db } from "@supa/db";
import { developerOrgs, marketplaceItems } from "@supa/db/schema";
import { eq, sql, desc } from "drizzle-orm";
import { adminAudit } from "@/lib/admin/audit";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type GrowthDomain = "developer" | "creator" | "partner" | "vertical" | "regional" | "enterprise" | "community";

export interface GrowthMetrics {
  domain: GrowthDomain;
  totalEntities: number;
  activeEntities: number;
  newThisMonth: number;
  growthRatePct: number;
}

export interface OnboardingChecklist {
  domain: GrowthDomain;
  entity: string;
  steps: Array<{ name: string; completed: boolean }>;
  completionPct: number;
}

// ───────────────────────────────────────────────
// Developer growth — self-serve onboarding.
// ───────────────────────────────────────────────

export function getDeveloperOnboardingChecklist(orgId: string): OnboardingChecklist {
  return {
    domain: "developer",
    entity: orgId,
    steps: [
      { name: "Create developer org", completed: true },
      { name: "Provision sandbox", completed: false },
      { name: "Read quickstart guide", completed: false },
      { name: "Install SDK", completed: false },
      { name: "Run sample app", completed: false },
      { name: "Join community forum", completed: false },
      { name: "Attend office hours", completed: false },
      { name: "Beta access enrollment", completed: false },
    ],
    completionPct: 12.5, // 1/8.
  };
}

// ───────────────────────────────────────────────
// Creator growth — marketplace onboarding + revenue.
// ───────────────────────────────────────────────

export function getCreatorOnboardingChecklist(orgId: string): OnboardingChecklist {
  return {
    domain: "creator",
    entity: orgId,
    steps: [
      { name: "Create developer org", completed: true },
      { name: "Complete creator profile", completed: false },
      { name: "Submit first marketplace item", completed: false },
      { name: "Pass automated quality checks", completed: false },
      { name: "Get first install", completed: false },
      { name: "Receive first rating", completed: false },
      { name: "Set up payout method", completed: false },
      { name: "Access revenue dashboard", completed: false },
    ],
    completionPct: 12.5,
  };
}

// ───────────────────────────────────────────────
// Partner growth — self-serve partner portal.
// ───────────────────────────────────────────────

export function getPartnerOnboardingChecklist(partnerOrgId: string): OnboardingChecklist {
  return {
    domain: "partner",
    entity: partnerOrgId,
    steps: [
      { name: "Register as partner", completed: true },
      { name: "Sign partnership agreement (automated)", completed: false },
      { name: "Configure branding", completed: false },
      { name: "Set allowed origins", completed: false },
      { name: "Pass compliance verification", completed: false },
      { name: "Provision embedded surface", completed: false },
      { name: "Test integration", completed: false },
      { name: "Go live", completed: false },
    ],
    completionPct: 12.5,
  };
}

// ───────────────────────────────────────────────
// Growth metrics — aggregate per domain.
// ───────────────────────────────────────────────

export async function getGrowthMetrics(): Promise<GrowthMetrics[]> {
  const metrics: GrowthMetrics[] = [];

  // Developer orgs.
  const devResult = await db.execute(sql`
    select
      count(*)::integer as total,
      count(*) filter (where status = 'active')::integer as active,
      count(*) filter (where created_at > now() - interval '30 days')::integer as new_this_month
    from developer_orgs
  `);
  const dev = (devResult as unknown as Array<{ total: number; active: number; new_this_month: number }>)[0];
  const devTotal = Number(dev?.total ?? 0);
  const devPrev = devTotal - Number(dev?.new_this_month ?? 0);
  metrics.push({
    domain: "developer",
    totalEntities: devTotal,
    activeEntities: Number(dev?.active ?? 0),
    newThisMonth: Number(dev?.new_this_month ?? 0),
    growthRatePct: devPrev > 0 ? (Number(dev?.new_this_month ?? 0) / devPrev) * 100 : 0,
  });

  // Marketplace items (creators).
  const marketResult = await db.execute(sql`
    select
      count(*)::integer as total,
      count(*) filter (where status = 'published')::integer as active,
      count(*) filter (where created_at > now() - interval '30 days')::integer as new_this_month
    from marketplace_items
  `);
  const market = (marketResult as unknown as Array<{ total: number; active: number; new_this_month: number }>)[0];
  const marketTotal = Number(market?.total ?? 0);
  const marketPrev = marketTotal - Number(market?.new_this_month ?? 0);
  metrics.push({
    domain: "creator",
    totalEntities: marketTotal,
    activeEntities: Number(market?.active ?? 0),
    newThisMonth: Number(market?.new_this_month ?? 0),
    growthRatePct: marketPrev > 0 ? (Number(market?.new_this_month ?? 0) / marketPrev) * 100 : 0,
  });

  // Verticals.
  const vertResult = await db.execute(sql`
    select
      count(*)::integer as total,
      count(*) filter (where status = 'published')::integer as active,
      count(*) filter (where created_at > now() - interval '30 days')::integer as new_this_month
    from vertical_configs
  `);
  const vert = (vertResult as unknown as Array<{ total: number; active: number; new_this_month: number }>)[0];
  const vertTotal = Number(vert?.total ?? 0);
  const vertPrev = vertTotal - Number(vert?.new_this_month ?? 0);
  metrics.push({
    domain: "vertical",
    totalEntities: vertTotal,
    activeEntities: Number(vert?.active ?? 0),
    newThisMonth: Number(vert?.new_this_month ?? 0),
    growthRatePct: vertPrev > 0 ? (Number(vert?.new_this_month ?? 0) / vertPrev) * 100 : 0,
  });

  // Regions.
  const regionResult = await db.execute(sql`
    select
      count(*)::integer as total,
      count(*) filter (where status = 'active')::integer as active,
      count(*) filter (where created_at > now() - interval '30 days')::integer as new_this_month
    from regional_playbooks
  `);
  const region = (regionResult as unknown as Array<{ total: number; active: number; new_this_month: number }>)[0];
  const regionTotal = Number(region?.total ?? 0);
  const regionPrev = regionTotal - Number(region?.new_this_month ?? 0);
  metrics.push({
    domain: "regional",
    totalEntities: regionTotal,
    activeEntities: Number(region?.active ?? 0),
    newThisMonth: Number(region?.new_this_month ?? 0),
    growthRatePct: regionPrev > 0 ? (Number(region?.new_this_month ?? 0) / regionPrev) * 100 : 0,
  });

  // Enterprise deployments.
  const entResult = await db.execute(sql`
    select
      count(*)::integer as total,
      count(*) filter (where status = 'running')::integer as active,
      count(*) filter (where created_at > now() - interval '30 days')::integer as new_this_month
    from enterprise_deployments
  `);
  const ent = (entResult as unknown as Array<{ total: number; active: number; new_this_month: number }>)[0];
  const entTotal = Number(ent?.total ?? 0);
  const entPrev = entTotal - Number(ent?.new_this_month ?? 0);
  metrics.push({
    domain: "enterprise",
    totalEntities: entTotal,
    activeEntities: Number(ent?.active ?? 0),
    newThisMonth: Number(ent?.new_this_month ?? 0),
    growthRatePct: entPrev > 0 ? (Number(ent?.new_this_month ?? 0) / entPrev) * 100 : 0,
  });

  return metrics;
}

// ───────────────────────────────────────────────
// Community growth — forums, Discord, GitHub, meetups.
// ───────────────────────────────────────────────

export interface CommunityStats {
  forumMembers: number;
  discordMembers: number;
  githubStars: number;
  githubContributors: number;
  meetupGroups: number;
  conferenceTalks: number;
}

export async function getCommunityStats(): Promise<CommunityStats> {
  // STUB: would query community platform APIs (Discourse, Discord, GitHub).
  return {
    forumMembers: 0,
    discordMembers: 0,
    githubStars: 0,
    githubContributors: 0,
    meetupGroups: 0,
    conferenceTalks: 0,
  };
}
