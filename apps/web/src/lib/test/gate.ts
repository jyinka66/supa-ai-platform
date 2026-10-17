import { NextResponse } from "next/server";

/**
 * Test-only endpoint gate.
 *
 * Returns a 404 response if the route is accessed in production.
 * Use at the top of every /api/test/* route handler:
 *
 *   export async function POST(req: NextRequest) {
 *     const gate = testGate();
 *     if (gate) return gate;
 *     ...
 *   }
 *
 * The gate is intentionally simple — NODE_ENV is set at build time and
 * can't be spoofed at runtime (unlike headers). For defense in depth,
 * we also check a TEST_API_SECRET env var if set; if present, callers must
 * send `Authorization: Bearer <secret>`.
 */
export function testGate(req?: Request): NextResponse | null {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "not_found" },
      { status: 404 },
    );
  }

  // Optional secret — if TEST_API_SECRET is set, callers must match it.
  // This prevents accidental access in staging environments (where
  // NODE_ENV !== 'production' but we still don't want open test endpoints).
  const secret = process.env.TEST_API_SECRET;
  if (secret) {
    const auth = req?.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  return null;
}
