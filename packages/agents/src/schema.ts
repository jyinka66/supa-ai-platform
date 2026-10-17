import { z } from "zod";

export const BudgetSpec = z.object({
  dailyUsdMinor: z.number().int().positive().max(50_000),   // $500/day cap
  monthlyUsdMinor: z.number().int().positive().max(200_000),
  maxRunsPerDay: z.number().int().positive().max(500),
  maxStepsPerRun: z.number().int().min(1).max(40),
  maxA2ADepth: z.number().int().min(0).max(3),
  alertAtPct: z.array(z.number().int().min(1).max(100)).default([50, 80, 95]),
});
export type BudgetSpec = z.infer<typeof BudgetSpec>;

export type ToolClass = "read_only" | "side_effect" | "financial" | "destructive";
export type ApprovalPolicy = "always" | "first_run" | "never_ask_but_log" | "always_two_gate";
