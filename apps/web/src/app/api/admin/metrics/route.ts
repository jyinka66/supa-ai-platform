import { NextRequest } from "next/server";
import { db } from "@supa/db";
import { sql } from "drizzle-orm";
import { requireAdminSession } from "@/lib/admin/middleware";
import { guard } from "@/lib/ratelimit/guard";
import { problem, ok } from "@/lib/api/problem";

/**
 * NOTE: Node.js runtime, not edge — Drizzle's postgres-js driver needs Node APIs.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ProviderStatsRow {
  [key: string]: unknown;
  day: string;
  provider: string;
  requests: number;
  output_tokens: number;
  input_tokens: number;
  cost_usd: string;
  avg_ttfb_ms: number | null;
  p95_ttfb_ms: number | null;
  p95_total_ms: number | null;
  retry_count: number;
  fallback_count: number;
}

interface BudgetBurnRow {
  [key: string]: unknown;
  budget_id: string;
  scope_type: "user" | "workspace";
  scope_id: string;
  cost_limit_usd: string;
  alert_threshold: string;
  mtd_usd: string;
  pct_used: string;
  projected_30d_usd: string;
  status: "ok" | "alert" | "exceeded";
}

interface FailureRow {
  [key: string]: unknown;
  provider: string;
  total_failures: number;
  avg_retries: string | null;
}

interface PromptPerfRow {
  [key: string]: unknown;
  prompt_version: string;
  language: string;
  thumbs_up: number;
  thumbs_down: number;
  approval_pct: string;
}

/**
 * GET /api/admin/metrics
 *
 * Returns aggregated metrics for the admin dashboard:
 *   - providerStats: per-provider daily rollup (requests, tokens, cost, latency)
 *   - budgetBurn: per-scope budget burn (MTD, projected, status)
 *   - failures: failure forensics summary (top 20 by failure count)
 *   - promptPerf: prompt version performance (thumbs up/down, approval %)
 *
 * Auth: caller must be a platform admin (owner/admin in any workspace).
 * Admin check is cached in Redis for 60s.
 *
 * Query params:
 *   ?days=7  — lookback window for provider stats (default 7, max 90)
 */
export async function GET(req: NextRequest) {
  // Rate-limit first — this endpoint runs expensive aggregation queries.
  const denied = await guard(req, "default");
  if (denied) return denied;

  // Admin session required — separate from product auth (admin control plane).
  // The admin must have an active admin_sessions row (argon2id token, 8h cap,
  // 30min idle, MFA-gated, IP-bound).
  let adminCtx;
  try {
    adminCtx = await requireAdminSession(req);
  } catch {
    return problem("UNAUTHENTICATED", {
      status: 401,
      message: "Admin session required.",
    });
  }
  // Role-based access: 'read_only' can view metrics; all roles can.
  // (No further restriction needed — all admin roles can view metrics.)

  // Parse lookback window.
  const url = new URL(req.url);
  const daysRaw = parseInt(url.searchParams.get("days") ?? "7", 10);
  const days = Math.min(Math.max(isNaN(daysRaw) ? 7 : daysRaw, 1), 90);

  // Run all 4 queries in parallel.
  const [providerStats, budgetBurn, failures, promptPerf] = await Promise.all([
    // 1. Provider stats — daily rollup for the lookback window.
    // Use parameter binding for `days` (already validated as 1..90 int).
    db.execute<ProviderStatsRow>(sql`
      select * from provider_stats_daily
      where day >= date_trunc('day', now() - make_interval(days => ${days}))
      order by day desc, provider
    `),

    // 2. Budget burn — all budgets with MTD spend + projection.
    db.execute<BudgetBurnRow>(sql`
      select * from workspace_budget_burn
      order by pct_used desc
    `),

    // 3. Failure forensics — top 20 providers by failure count.
    db.execute<FailureRow>(sql`
      select
        provider,
        sum(failures)::int as total_failures,
        round(avg(avg_retries)::numeric, 2) as avg_retries
      from failure_forensics
      group by provider
      order by total_failures desc
      limit 20
    `),

    // 4. Prompt performance — thumbs up/down per prompt version.
    // NOTE: we don't have a `prompt_versions` table; prompt versions are
    // tracked on `messages.prompt_version` (a text column). We aggregate
    // directly from there.
    db.execute<PromptPerfRow>(sql`
      select
        m.prompt_version,
        'all' as language,
        count(mf.*) filter (where mf.rating = 1)   as thumbs_up,
        count(mf.*) filter (where mf.rating = -1)  as thumbs_down,
        round(
          count(mf.*) filter (where mf.rating = 1)::numeric
          / greatest(count(mf.*), 1) * 100,
          1
        ) as approval_pct
      from messages m
      left join message_feedback mf on mf.message_id = m.id
      where m.prompt_version is not null
        and m.role = 'assistant'
        and m.created_at >= now() - interval '30 days'
      group by m.prompt_version
      order by approval_pct desc, thumbs_up desc
      limit 20
    `),
  ]);

  return ok({
    providerStats: providerStats ?? [],
    budgetBurn: budgetBurn ?? [],
    failures: failures ?? [],
    promptPerf: promptPerf ?? [],
    generatedAt: new Date().toISOString(),
    lookbackDays: days,
  });
}
