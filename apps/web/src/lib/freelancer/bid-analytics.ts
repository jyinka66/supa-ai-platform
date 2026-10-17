// Bid analytics — conversion rates, win/loss ratios, average contract size,
// top-performing proposal styles.
//
// This module computes analytics from a list of historical bids. In Phase 2
// these will be DB-backed aggregate queries; in Phase 1 they're computed
// in-memory from the bid records passed in.

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type BidOutcome = "won" | "lost" | "pending" | "withdrawn" | "expired";

export interface BidRecord {
  id: string;
  jobId: string;
  jobTitle: string;
  platform: "upwork" | "fiverr" | "direct" | "other";
  submittedAt: string;
  outcome: BidOutcome;
  resolvedAt: string | null;
  contractValue?: number;
  currency: string;
  /** Which proposal tone was used. */
  proposalTone: "consultative" | "direct" | "bold" | "educational";
  /** The semantic match score when the bid was placed. */
  matchScore: number;
  /** Whether this was auto-bid or manual. */
  autoBid: boolean;
}

export interface BidAnalytics {
  totalBids: number;
  totalWon: number;
  totalLost: number;
  totalPending: number;
  conversionRate: number;            // won / (won + lost)
  averageContractValue: number;
  totalRevenue: number;
  averageMatchScore: number;
  autoBidCount: number;
  autoBidWinRate: number;
  manualBidWinRate: number;
  /** Win rate per platform. */
  byPlatform: Record<string, { bids: number; won: number; winRate: number }>;
  /** Win rate per proposal tone. */
  byTone: Record<string, { bids: number; won: number; winRate: number }>;
  /** Win rate by match-score bucket. */
  byMatchScoreBucket: Array<{ bucket: string; bids: number; won: number; winRate: number }>;
  /** Recent trend (last 7 days of bids). */
  recentTrend: Array<{ date: string; bids: number; won: number }>;
}

// ───────────────────────────────────────────────
// computeBidAnalytics — the main entry point.
// ───────────────────────────────────────────────

export function computeBidAnalytics(bids: BidRecord[]): BidAnalytics {
  const totalBids = bids.length;
  const won = bids.filter((b) => b.outcome === "won");
  const lost = bids.filter((b) => b.outcome === "lost");
  const pending = bids.filter((b) => b.outcome === "pending");
  const totalWon = won.length;
  const totalLost = lost.length;
  const conversionRate = totalWon + totalLost > 0 ? totalWon / (totalWon + totalLost) : 0;

  const contractValues = won.map((b) => b.contractValue ?? 0).filter((v) => v > 0);
  const averageContractValue = contractValues.length > 0
    ? contractValues.reduce((a, b) => a + b, 0) / contractValues.length
    : 0;
  const totalRevenue = contractValues.reduce((a, b) => a + b, 0);

  const matchScores = bids.map((b) => b.matchScore).filter((s) => s > 0);
  const averageMatchScore = matchScores.length > 0
    ? matchScores.reduce((a, b) => a + b, 0) / matchScores.length
    : 0;

  const autoBids = bids.filter((b) => b.autoBid);
  const autoBidWon = autoBids.filter((b) => b.outcome === "won");
  const autoBidLost = autoBids.filter((b) => b.outcome === "lost");
  const manualBids = bids.filter((b) => !b.autoBid);
  const manualBidWon = manualBids.filter((b) => b.outcome === "won");
  const manualBidLost = manualBids.filter((b) => b.outcome === "lost");

  const autoBidWinRate = autoBidWon.length + autoBidLost.length > 0
    ? autoBidWon.length / (autoBidWon.length + autoBidLost.length)
    : 0;
  const manualBidWinRate = manualBidWon.length + manualBidLost.length > 0
    ? manualBidWon.length / (manualBidWon.length + manualBidLost.length)
    : 0;

  // By platform
  const byPlatform: BidAnalytics["byPlatform"] = {};
  for (const bid of bids) {
    if (!byPlatform[bid.platform]) byPlatform[bid.platform] = { bids: 0, won: 0, winRate: 0 };
    const platformEntry = byPlatform[bid.platform];
    if (platformEntry) {
      platformEntry.bids++;
      if (bid.outcome === "won") platformEntry.won++;
    }
  }
  for (const p of Object.keys(byPlatform)) {
    const d = byPlatform[p];
    if (!d) continue;
    d.winRate = d.bids > 0 ? d.won / d.bids : 0;
  }

  // By tone
  const byTone: BidAnalytics["byTone"] = {};
  for (const bid of bids) {
    if (!byTone[bid.proposalTone]) byTone[bid.proposalTone] = { bids: 0, won: 0, winRate: 0 };
    const toneEntry = byTone[bid.proposalTone];
    if (toneEntry) {
      toneEntry.bids++;
      if (bid.outcome === "won") toneEntry.won++;
    }
  }
  for (const t of Object.keys(byTone)) {
    const d = byTone[t];
    if (!d) continue;
    d.winRate = d.bids > 0 ? d.won / d.bids : 0;
  }

  // By match-score bucket
  const buckets = [
    { label: "0-50%", min: 0, max: 50 },
    { label: "50-70%", min: 50, max: 70 },
    { label: "70-85%", min: 70, max: 85 },
    { label: "85-95%", min: 85, max: 95 },
    { label: "95-100%", min: 95, max: 101 },
  ];
  const byMatchScoreBucket = buckets.map((bucket) => {
    const inBucket = bids.filter((b) => b.matchScore >= bucket.min && b.matchScore < bucket.max);
    const wonInBucket = inBucket.filter((b) => b.outcome === "won");
    return {
      bucket: bucket.label,
      bids: inBucket.length,
      won: wonInBucket.length,
      winRate: inBucket.length > 0 ? wonInBucket.length / inBucket.length : 0,
    };
  });

  // Recent trend (last 7 days)
  const now = new Date();
  const recentTrend: Array<{ date: string; bids: number; won: number }> = [];
  for (let i = 6; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().slice(0, 10);
    const dayBids = bids.filter((b) => b.submittedAt.slice(0, 10) === dateStr);
    const dayWon = dayBids.filter((b) => b.outcome === "won" && b.resolvedAt?.slice(0, 10) === dateStr);
    recentTrend.push({ date: dateStr, bids: dayBids.length, won: dayWon.length });
  }

  return {
    totalBids,
    totalWon,
    totalLost,
    totalPending: pending.length,
    conversionRate,
    averageContractValue,
    totalRevenue,
    averageMatchScore,
    autoBidCount: autoBids.length,
    autoBidWinRate,
    manualBidWinRate,
    byPlatform,
    byTone,
    byMatchScoreBucket,
    recentTrend,
  };
}
