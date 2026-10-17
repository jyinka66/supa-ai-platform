import { db } from "@supa/db";
import { sql } from "drizzle-orm";
import { pino } from "@/lib/observability/logger";

const log = pino.child({ module: "feedback.evaluate" });

const MIN_SAMPLE = 100;
const Z_CRITICAL = 1.96; // p < 0.05 two-tailed

interface PromptStatsRow {
  [key: string]: unknown;
  version: string;
  mode: string;
  language: string;
  n: string;
  approval_rate: string;
}

interface VersionStats {
  version: string;
  mode: string;
  language: string;
  n: number;
  approvalRate: number;
}

/**
 * Evaluates prompt versions and promotes statistically significant winners.
 *
 * Cron-invoked (Vercel Cron, daily). The cron route is at
 * /api/cron/evaluate-prompts and is gated by CRON_SECRET.
 *
 * Algorithm:
 *   1. Aggregate feedback counts per (mode, language, version) slot.
 *   2. Filter to slots with >= MIN_SAMPLE feedback responses.
 *   3. For each slot with >= 2 versions, run a two-proportion z-test.
 *   4. If |z| > 1.96 AND the winner has higher approval, promote it:
 *      - Set is_active = true for the winner
 *      - Set is_active = false for all others in the same slot
 *      - Insert an audit row into prompt_promotions
 *
 * The z-test approximates statistical significance for comparing two
 * proportions (approval rates). It's not a substitute for a full Bayesian
 * A/B test, but it's good enough for daily promotion decisions.
 *
 * Returns a summary of promotions for logging/observability.
 */
export async function evaluatePromptVersions(): Promise<{
  slotsEvaluated: number;
  promotions: number;
  promoted: Array<{ slot: string; winner: string; loser: string; zScore: number }>;
}> {
  // 1. Aggregate feedback per (mode, language, version).
  // NOTE: `mode` is on `conversations`, not `messages`. `language` on
  // `messages` is `language_detected` (per-message) — we use the
  // conversation's `language_pref` instead, falling back to 'en'.
  // The `language` value MUST match the prompt_versions CHECK constraint
  // (`^[a-z]{2}(-[A-Z]{2})?$`), so we use 'en' as the fallback (NOT 'all').
  const rows = await db.execute<PromptStatsRow>(sql`
    select
      m.prompt_version as version,
      c.mode,
      coalesce(c.language_pref, 'en') as language,
      count(mf.*) as n,
      avg((mf.rating + 1) / 2.0)::numeric as approval_rate
    from messages m
    join message_feedback mf on mf.message_id = m.id
    join conversations c on c.id = m.conversation_id
    where m.prompt_version is not null
      and m.role = 'assistant'
      and m.created_at >= now() - interval '30 days'
    group by 1, 2, 3
    having count(mf.*) >= ${MIN_SAMPLE}
  `);

  if (!rows || rows.length === 0) {
    log.info({ event: "prompt_eval_no_data" });
    return { slotsEvaluated: 0, promotions: 0, promoted: [] };
  }

  // 2. Group by slot (mode + language).
  const bySlot = new Map<string, VersionStats[]>();
  for (const r of rows) {
    const slot = `${r.mode}:${r.language}`;
    const stats: VersionStats = {
      version: r.version,
      mode: r.mode,
      language: r.language,
      n: Number(r.n),
      approvalRate: Number(r.approval_rate),
    };
    const arr = bySlot.get(slot) ?? [];
    arr.push(stats);
    bySlot.set(slot, arr);
  }

  log.info({
    event: "prompt_eval_start",
    slots: bySlot.size,
    versions: rows.length,
  });

  // 3. For each slot with >= 2 versions, run the z-test.
  const promoted: Array<{ slot: string; winner: string; loser: string; zScore: number }> = [];
  let slotsEvaluated = 0;

  for (const [slot, versions] of bySlot) {
    if (versions.length < 2) continue;
    slotsEvaluated++;

    // Sort by approval rate descending.
    const sorted = [...versions].sort((a, b) => b.approvalRate - a.approvalRate);
    const best = sorted[0]!;
    const challenger = sorted[1]!;

    // Two-proportion z-test.
    const z = twoProportionZTest(
      best.approvalRate,
      best.n,
      challenger.approvalRate,
      challenger.n,
    );

    if (Math.abs(z) > Z_CRITICAL && best.approvalRate > challenger.approvalRate) {
      // Promote the winner.
      await promoteWinner(best, challenger, z);
      promoted.push({
        slot,
        winner: best.version,
        loser: challenger.version,
        zScore: z,
      });
    }
  }

  log.info({
    event: "prompt_eval_complete",
    slots_evaluated: slotsEvaluated,
    promotions: promoted.length,
  });

  return {
    slotsEvaluated,
    promotions: promoted.length,
    promoted,
  };
}

/**
 * Two-proportion z-test.
 *
 * Tests whether two proportions (p1, p2) are significantly different.
 * Returns the z-score. A |z| > 1.96 indicates p < 0.05 (two-tailed).
 *
 * Formula:
 *   z = (p1 - p2) / sqrt(p1*(1-p1)/n1 + p2*(1-p2)/n2)
 *
 * Returns 0 if the standard error is 0 (e.g. both proportions are 0 or 1).
 */
function twoProportionZTest(
  p1: number,
  n1: number,
  p2: number,
  n2: number,
): number {
  if (n1 === 0 || n2 === 0) return 0;
  const se = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
  if (se === 0) return 0;
  return (p1 - p2) / se;
}

/**
 * Promotes the winner: sets is_active = true for the winner, false for
 * all other versions in the same slot, and inserts an audit row.
 */
async function promoteWinner(
  winner: VersionStats,
  loser: VersionStats,
  zScore: number,
): Promise<void> {
  // 1. Deactivate all other versions in the slot.
  await db.execute(sql`
    update prompt_versions
    set is_active = false
    where mode = ${winner.mode}
      and language = ${winner.language}
      and version != ${winner.version}
  `);

  // 2. Activate the winner.
  await db.execute(sql`
    update prompt_versions
    set is_active = true
    where mode = ${winner.mode}
      and language = ${winner.language}
      and version = ${winner.version}
  `);

  // 3. Insert audit row.
  await db.execute(sql`
    insert into prompt_promotions (
      slot, winner_version, loser_version, z_score,
      winner_approval, loser_approval, winner_n, loser_n, decided_at
    ) values (
      ${winner.mode}:${winner.language},
      ${winner.version},
      ${loser.version},
      ${zScore.toFixed(6)},
      ${winner.approvalRate.toFixed(4)},
      ${loser.approvalRate.toFixed(4)},
      ${winner.n},
      ${loser.n},
      now()
    )
  `);

  log.info({
    event: "prompt_promoted",
    slot: `${winner.mode}:${winner.language}`,
    winner: winner.version,
    loser: loser.version,
    z_score: zScore.toFixed(4),
    winner_approval: winner.approvalRate.toFixed(4),
    loser_approval: loser.approvalRate.toFixed(4),
  });
}
