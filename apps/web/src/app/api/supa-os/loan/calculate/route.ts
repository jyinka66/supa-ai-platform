// POST /api/supa-os/loan/calculate
//
// Calculates a loan amortization schedule + summary. Used by the standalone
// loan calculator UI (no build session needed).
//
// Body:
//   principal: number (positive, max $10M)
//   annualInterestRate: number (percent, 0-100)
//   termMonths: number (1-360)
//   startDate?: ISO date string (defaults to today)
//
// Auth: admin session (read_only — fintech tools are admin-gated for now).

import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody } from "@/lib/api/route-helpers";
import { calculateLoanAmortization, calculateLoanSummary } from "@/lib/supa-os/loan-banking-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  principal: z.number().positive().max(10_000_000),
  annualInterestRate: z.number().min(0).max(100),
  termMonths: z.number().int().min(1).max(360),
  startDate: z.string().datetime().optional(),
});

export const POST = adminOnly("read_only", async (req, ctx) => {
  const body = await parseJsonBody(req, BodySchema);
  const startDate = body.startDate ? new Date(body.startDate) : undefined;

  const schedule = calculateLoanAmortization({
    principal: body.principal,
    annualInterestRate: body.annualInterestRate,
    termMonths: body.termMonths,
  });
  const summary = calculateLoanSummary({
    principal: body.principal,
    annualInterestRate: body.annualInterestRate,
    termMonths: body.termMonths,
  }, startDate);

  return okResponse({ schedule, summary });
});
