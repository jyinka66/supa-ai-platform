// POST /api/expansion/verification
//
// Runs automated verification checks (8 checks) and optionally human
// verifications (sign-offs) for a region before soft-launch.
//
// Body:
//   regionCode: string
//   includeHumanChecks?: boolean (default true)
//
// Returns: { automatedChecks, humanVerifications, recommendation }
//
// Auth: admin senior.

import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody } from "@/lib/api/route-helpers";
import {
  runAllAutomatedChecks,
  checkHumanVerifications,
  AUTOMATED_CHECKS,
  HUMAN_VERIFICATIONS,
} from "@/lib/expansion/stage-verification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  regionCode: z.string().min(2).max(8).regex(/^[A-Z_-]+$/i),
  includeHumanChecks: z.boolean().optional(),
});

export const POST = adminOnly("senior", async (req, ctx) => {
  const body = await parseJsonBody(req, BodySchema);
  const includeHuman = body.includeHumanChecks ?? true;

  const [automatedChecks, humanVerifications] = await Promise.all([
    runAllAutomatedChecks(body.regionCode),
    includeHuman ? checkHumanVerifications(body.regionCode) : Promise.resolve([]),
  ]);

  // Compute recommendation: "go" only if all automated checks pass and no
  // human verifications are pending.
  const allAutomatedPass = automatedChecks.every((c) => c.status === "pass");
  const allHumansSigned = humanVerifications.every((h) => h.status === "signed_off");
  const recommendation =
    !allAutomatedPass ? "no_go" :
    !allHumansSigned ? "pending_human" :
    "go";

  return okResponse({
    regionCode: body.regionCode,
    automatedChecks,
    humanVerifications,
    recommendation,
    totalChecks: AUTOMATED_CHECKS.length,
    totalHumanVerifications: HUMAN_VERIFICATIONS.length,
    verifiedBy: ctx.admin!.adminId,
    verifiedAt: new Date().toISOString(),
  });
});
