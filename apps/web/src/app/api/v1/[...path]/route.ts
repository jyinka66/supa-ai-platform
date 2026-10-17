// Next.js App Router catch-all for /api/v1/* — dispatches to the v1 router.
//
// Every v1 request goes through handleV1:
//   1. authenticateApiKey — Bearer → prefix lookup → hash verify → rate limit.
//   2. requireScope — the route's declared x-scope.
//   3. Route handler — the module-specific logic.
//
// The catch-all [...path] captures everything after /api/v1/. The router
// matches method + path against the ROUTES table.

import { NextRequest } from "next/server";
import { handleV1 } from "@/lib/api/v1/router";

export async function GET(req: NextRequest) {
  return handleV1(req);
}

export async function POST(req: NextRequest) {
  return handleV1(req);
}

export async function PUT(req: NextRequest) {
  return handleV1(req);
}

export async function PATCH(req: NextRequest) {
  return handleV1(req);
}

export async function DELETE(req: NextRequest) {
  return handleV1(req);
}

// Opt out of static generation — the v1 API is always dynamic (auth +
// rate limit + DB queries per request).
export const dynamic = "force-dynamic";
