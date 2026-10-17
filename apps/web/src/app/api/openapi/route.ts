// GET /api/openapi.json
//
// Returns the OpenAPI 3.1 spec for all 98+ routes across the 4 namespaces
// (Supa OS, Builder, Governance, Expansion). Consumable by Swagger UI,
// Postman, or SDK generators.
//
// Auth: admin session (the spec includes admin-only routes).

import { NextRequest } from "next/server";
import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { generateOpenApiSpec } from "@/lib/openapi/generator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  const spec = generateOpenApiSpec();
  return okResponse(spec);
});
