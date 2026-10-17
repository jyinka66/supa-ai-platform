// GET /api/governance/transparency-audiences
//
// Returns the transparency audience catalog — what's visible to users,
// auditors, regulators, and the public.

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import {
  USER_TRANSPARENCY,
  AUDITOR_TRANSPARENCY,
  AUDITOR_DATA_ACCESS_RULE,
  REGULATOR_TRANSPARENCY,
  REGULATOR_REPORTING_CHANNEL,
} from "@/lib/governance/transparency-audiences";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  return okResponse({
    userTransparency: USER_TRANSPARENCY,
    auditorTransparency: AUDITOR_TRANSPARENCY,
    auditorDataAccessRule: AUDITOR_DATA_ACCESS_RULE,
    regulatorTransparency: REGULATOR_TRANSPARENCY,
    regulatorReportingChannel: REGULATOR_REPORTING_CHANNEL,
  });
});
