// GET /api/builder/sessions/[id]/sandbox/audit
//
// Runs a security audit on the build session's sandbox — checks the 10
// security boundaries (perimeter, auth, secret storage, network egress,
// file system, process, memory, CPU, time, audit).

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { getBuildSession } from "@/lib/builder/build-session";
import { runSecurityAudit, SECURITY_BOUNDARIES, verifySecurityModel } from "@/lib/builder/security-model";
import { ApiError } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  const id = (req as unknown as { params?: Record<string, string | undefined> }).params?.id;
  if (!id) throw new ApiError("not_found", 404, { param: "id" });

  const session = await getBuildSession(id);
  if (!session) throw new ApiError("not_found", 404, { sessionId: id });

  const audit = runSecurityAudit();

  return okResponse({
    sessionId: id,
    audit,
    boundaries: SECURITY_BOUNDARIES,
    verification: verifySecurityModel(),
    auditedAt: new Date().toISOString(),
  });
});
