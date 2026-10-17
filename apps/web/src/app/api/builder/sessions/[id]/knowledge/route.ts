// GET /api/builder/sessions/[id]/knowledge
//
// Returns the knowledge hub for a build session: 12 dimensions of knowledge
// (code, schema, apis, ui, tests, config, env, deps, integrations, history,
// logs, metrics) + a sample reasoning trace.

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { getBuildSession } from "@/lib/builder/build-session";
import { getKnowledgeHub, traceBookingBug, KNOWLEDGE_DIMENSIONS, verifyAppKnowledge } from "@/lib/builder/app-knowledge";
import { ApiError } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  const id = (req as unknown as { params?: Record<string, string | undefined> }).params?.id;
  if (!id) throw new ApiError("not_found", 404, { param: "id" });

  const session = await getBuildSession(id);
  if (!session) throw new ApiError("not_found", 404, { sessionId: id });

  const [hub, sampleTrace] = await Promise.all([
    getKnowledgeHub(id),
    Promise.resolve(traceBookingBug()),
  ]);

  return okResponse({
    sessionId: id,
    hub,
    dimensions: KNOWLEDGE_DIMENSIONS,
    verification: verifyAppKnowledge(),
    sampleReasoningTrace: sampleTrace,
  });
});
