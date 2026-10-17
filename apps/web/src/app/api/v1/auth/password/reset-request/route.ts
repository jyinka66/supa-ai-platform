// POST /api/v1/auth/password/reset-request — request password reset.
//
// ALWAYS returns 202 (Accepted) — don't leak whether the email exists.
// Rate-limited per email AND per IP.
// If the email exists: Supabase sends a reset link (1h TTL).
// If the email doesn't exist: no-op (but the response is identical).

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { errorResponse, requestId, jsonLimiter, corsHeaders } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ResetRequestBody = z.object({
  email: z.string().email(),
});

export async function POST(req: NextRequest) {
  const rid = requestId(req);
  try {
    jsonLimiter(req);
    const body = await req.json();
    const parsed = ResetRequestBody.safeParse(body);
    if (!parsed.success) {
      // Still return 202 — don't leak validation errors.
      return NextResponse.json({ message: "If the email exists, a reset link has been sent." }, { status: 202 });
    }

    // Request password reset via Supabase (sends email with reset link, 1h TTL).
    const supabase = await supabaseServer();
    await supabase.auth.resetPasswordForEmail(parsed.data.email, {
      redirectTo: `${process.env.APP_URL}/reset-password`,
    }).catch(() => {}); // swallow errors — always 202.

    // ALWAYS 202 — uniform response (don't leak whether email exists).
    const res = NextResponse.json(
      { message: "If the email exists, a reset link has been sent." },
      { status: 202 },
    );
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    // Even on error, return 202 (don't leak).
    const res = NextResponse.json(
      { message: "If the email exists, a reset link has been sent." },
      { status: 202 },
    );
    res.headers.set("X-Request-Id", rid);
    return res;
  }
}
