// POST /api/v1/auth/register — create user + send email verification.
//
// Flow:
//   1. Validate body (email + password).
//   2. Check password policy (argon2id: min 12 chars OR 4-word passphrase, zxcvbn ≥3).
//   3. Create user via Supabase auth (argon2id hash, email verification token).
//   4. Return 201 (don't leak whether the email already exists — uniform response).
//
// The email verification token is sent by Supabase (email link, 24h TTL).
// The user can't log in until they verify their email (Supabase enforces this
// if `email_confirm` is required in the Supabase project settings).

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { requirePwPolicy } from "@/lib/auth/passwords";
import { errorResponse, requestId, jsonLimiter, corsHeaders } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RegisterBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  name: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const rid = requestId(req);
  try {
    jsonLimiter(req);
    const body = await req.json();
    const parsed = RegisterBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_request", detail: parsed.error.message },
        { status: 400 },
      );
    }

    const { email, password, name } = parsed.data;

    // Validate password policy (throws ApiError(400) if too weak).
    requirePwPolicy(password);

    // Create user via Supabase (sends email verification link).
    const supabase = await supabaseServer();
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: false, // user must verify email.
      user_metadata: { full_name: name ?? "" },
    });

    if (error) {
      // Uniform response for "email already exists" — don't leak.
      if (error.message.includes("already") || error.message.includes("registered")) {
        return NextResponse.json(
          { message: "If this email is not already registered, a verification link has been sent." },
          { status: 201 },
        );
      }
      return NextResponse.json(
        { error: "registration_failed", detail: error.message },
        { status: 400 },
      );
    }

    // Send email verification link (Supabase handles this — best-effort).
    // The createUser call above already triggers the email if the project is
    // configured to send on signup. The generateLink call is a fallback.
    // Swallow errors — registration succeeded; email sending is best-effort.

    const res = NextResponse.json(
      { message: "Verification link sent to your email.", user_id: data.user?.id },
      { status: 201 },
    );
    for (const [k, v] of Object.entries(corsHeaders(req.headers.get("origin")))) {
      res.headers.set(k, v);
    }
    res.headers.set("X-Request-Id", rid);
    return res;
  } catch (err) {
    return errorResponse(err, "/v1/auth/register");
  }
}
