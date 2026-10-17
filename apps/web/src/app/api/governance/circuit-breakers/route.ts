// GET /api/governance/circuit-breakers
// POST /api/governance/circuit-breakers/[id]
//
// GET: lists all circuit breakers + their current state.
// POST /:id: trips (open) or resets (close) a specific breaker.

import { NextRequest } from "next/server";
import { z } from "zod";
import { adminOnly, okResponse, parseJsonBody } from "@/lib/api/route-helpers";
import {
  GOVERNANCE_BREAKERS,
  evaluateBreaker,
  isBreakerOpen,
  type GovernanceBreakerType,
} from "@/lib/governance/circuit-breakers";
import { ApiError } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  const url = new URL(req.url);
  const evaluate = url.searchParams.get("evaluate") === "true";

  const breakers = await Promise.all(
    GOVERNANCE_BREAKERS.map(async (spec) => {
      const result = evaluate
        ? await evaluateBreaker(spec.type).catch(() => null)
        : null;
      return {
        spec,
        state: isBreakerOpen(spec.type) ? "open" : "closed",
        evaluation: result,
      };
    }),
  );

  return okResponse({
    breakers,
    total: GOVERNANCE_BREAKERS.length,
    openBreakers: breakers.filter((b) => b.state === "open").length,
  });
});
