// GET /api/governance/developer-ecosystem
//
// Returns the developer ecosystem governance: sandbox limits, API key
// governance, abuse detection rules, and SDK release governance.

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import {
  type AbuseLevel,
  type SdkReleaseStatus,
} from "@/lib/governance/developer-ecosystem";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Re-export the static catalogs (the lib has them as types only; we expose
// the value-level constants here).
const ABUSE_LEVELS: { level: AbuseLevel; title: string; description: string }[] = [
  { level: "rate_limited", title: "Rate Limited", description: "Temporary rate-limit applied (auto-recovers)." },
  { level: "warning", title: "Warning", description: "Issued a written warning to the developer." },
  { level: "suspended", title: "Suspended", description: "API key suspended; cannot make calls until reinstated." },
  { level: "banned", title: "Banned", description: "Developer banned; all keys revoked; appeals go to committee." },
];

const SDK_RELEASE_STATUSES: { status: SdkReleaseStatus; title: string }[] = [
  { status: "signed", title: "Signed" },
  { status: "published", title: "Published" },
  { status: "deprecated", title: "Deprecated" },
  { status: "yanked", title: "Yanked (pulled from registry)" },
];

export const GET = adminOnly("read_only", async (req, ctx) => {
  return okResponse({
    abuseLevels: ABUSE_LEVELS,
    sdkReleaseStatuses: SDK_RELEASE_STATUSES,
  });
});
