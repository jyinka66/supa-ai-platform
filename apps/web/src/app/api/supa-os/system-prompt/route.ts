// GET /api/supa-os/system-prompt
//
// Returns the system prompt catalog: the core mission, the 4 System 2
// reasoning phases, the 25 output rules, and the 12 prohibited patterns.
// Useful for documentation, debugging, and the admin observability dashboard.

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import {
  CORE_MISSION,
  REASONING_PHASES,
  OUTPUT_RULES,
  PROHIBITED_PATTERNS,
  COMPLIANCE_GATES,
} from "@/lib/supa-os/system-prompt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  return okResponse({
    mission: CORE_MISSION,
    reasoningPhases: REASONING_PHASES,
    outputRules: OUTPUT_RULES,
    prohibitedPatterns: PROHIBITED_PATTERNS,
    complianceGates: COMPLIANCE_GATES,
    totals: {
      reasoningPhases: REASONING_PHASES.length,
      outputRules: OUTPUT_RULES.length,
      prohibitedPatterns: PROHIBITED_PATTERNS.length,
      complianceGates: COMPLIANCE_GATES.length,
    },
  });
});
