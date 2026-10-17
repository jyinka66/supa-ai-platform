// POST /api/expansion/evaluation
//
// Evaluates market fit for a region: market size, internet penetration,
// smartphone penetration, freelancer/SMB/enterprise presence, language
// readiness, payment readiness.
//
// Body:
//   regionCode: string
//   includeLanguageReadiness?: boolean (default true)
//   includePaymentReadiness?: boolean (default true)
//
// Returns: { marketFit, languageReadiness, paymentReadiness }
//
// Auth: admin read_only.

import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody } from "@/lib/api/route-helpers";
import {
  evaluateMarketFit,
  evaluateLanguageReadiness,
  evaluatePaymentReadiness,
  MARKET_FIT_CRITERIA,
} from "@/lib/expansion/stage-evaluation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  regionCode: z.string().min(2).max(8).regex(/^[A-Z_-]+$/i),
  includeLanguageReadiness: z.boolean().optional(),
  includePaymentReadiness: z.boolean().optional(),
});

export const POST = adminOnly("read_only", async (req, ctx) => {
  const body = await parseJsonBody(req, BodySchema);

  const includeLang = body.includeLanguageReadiness ?? true;
  const includePay = body.includePaymentReadiness ?? true;

  const [marketFit, languageReadiness, paymentReadiness] = await Promise.all([
    evaluateMarketFit(body.regionCode),
    includeLang ? evaluateLanguageReadiness(body.regionCode) : Promise.resolve(null),
    includePay ? evaluatePaymentReadiness(body.regionCode) : Promise.resolve(null),
  ]);

  return okResponse({
    regionCode: body.regionCode,
    marketFit,
    languageReadiness,
    paymentReadiness,
    criteria: MARKET_FIT_CRITERIA,
    evaluatedBy: ctx.admin!.adminId,
    evaluatedAt: new Date().toISOString(),
  });
});
