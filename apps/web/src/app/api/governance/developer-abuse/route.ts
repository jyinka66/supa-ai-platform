// POST /api/governance/developer-abuse
//
// Detects developer abuse patterns (rate limit evasion, key sharing, scrapers,
// SDK misuse, etc.) and returns the recommended response (rate_limited,
// warning, suspended, banned).

import { NextRequest } from "next/server";
import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody } from "@/lib/api/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  developerId: z.string().min(1).max(100),
  signals: z.array(z.object({
    type: z.enum([
      "rate_limit_evasion", "key_sharing", "scraper_pattern",
      "sdk_misuse", "abuse_endpoint", "tos_violation",
      "data_exfiltration", "auth_bypass_attempt",
    ]),
    occurrences: z.number().int().min(1).max(1000),
    windowMinutes: z.number().int().min(1).max(10080),
    evidence: z.string().max(2000).optional(),
  })).min(1).max(50),
  developerReputation: z.number().min(0).max(100).optional(),
});

const ABUSE_LEVELS = [
  { level: "rate_limited", minScore: 1, title: "Rate Limited" },
  { level: "warning", minScore: 10, title: "Warning" },
  { level: "suspended", minScore: 30, title: "Suspended" },
  { level: "banned", minScore: 70, title: "Banned" },
] as const;

function computeAbuseLevel(signals: z.infer<typeof BodySchema>["signals"], reputation: number): {
  level: typeof ABUSE_LEVELS[number]["level"];
  score: number;
  reasons: string[];
} {
  let score = 0;
  const reasons: string[] = [];
  for (const signal of signals) {
    const weight =
      signal.type === "data_exfiltration" ? 30 :
      signal.type === "auth_bypass_attempt" ? 30 :
      signal.type === "key_sharing" ? 15 :
      signal.type === "scraper_pattern" ? 10 :
      signal.type === "rate_limit_evasion" ? 8 :
      signal.type === "sdk_misuse" ? 5 :
      signal.type === "tos_violation" ? 12 :
      5; // abuse_endpoint
    const contribution = weight * Math.min(signal.occurrences, 10);
    score += contribution;
    reasons.push(`${signal.type}: +${contribution} (${signal.occurrences} occurrences in ${signal.windowMinutes}min)`);
  }
  // Reputation discount: trusted developers get the benefit of the doubt.
  if (reputation >= 80) score = Math.floor(score * 0.7);
  else if (reputation >= 60) score = Math.floor(score * 0.85);
  // Lower reputation amplifies.
  else if (reputation < 30) score = Math.floor(score * 1.3);

  const level = ABUSE_LEVELS.slice().reverse().find((l) => score >= l.minScore)?.level ?? "rate_limited";
  return { level, score, reasons };
}

export const POST = adminOnly("senior", async (req, ctx) => {
  const body = await parseJsonBody(req, BodySchema);
  const result = computeAbuseLevel(body.signals, body.developerReputation ?? 50);

  return okResponse({
    request: body,
    abuse: result,
    abuseLevels: ABUSE_LEVELS,
    checkedBy: ctx.admin!.adminId,
    checkedAt: new Date().toISOString(),
  });
});
