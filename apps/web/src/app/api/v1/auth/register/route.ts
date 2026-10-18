import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { ApiError as PasswordPolicyError, requirePwPolicy } from "@/lib/auth/passwords";
import { errorResponse, requestId, jsonLimiter, corsHeaders } from "@/lib/http/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RegisterBody = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(256),
  name: z.string().trim().max(100).optional(),
  locale: z.enum(["en", "ar", "fr", "es", "de", "pt", "zh", "ja", "ko", "hi"]).default("en"),
});

function respond(
  req: NextRequest,
  rid: string,
  body: Record<string, string>,
  status: number,
): NextResponse {
  const res = NextResponse.json(body, { status });
  for (const [key, value] of Object.entries(corsHeaders(req.headers.get("origin")))) {
    res.headers.set(key, value);
  }
  res.headers.set("X-Request-Id", rid);
  return res;
}

/**
 * Register through Supabase's public sign-up flow. Unlike auth.admin.createUser,
 * auth.signUp triggers the configured confirmation-email flow and does not
 * require using a service-role key for a public registration form.
 */
export async function POST(req: NextRequest) {
  const rid = requestId(req);
  try {
    jsonLimiter(req);
    const body: unknown = await req.json();
    const parsed = RegisterBody.safeParse(body);
    if (!parsed.success) {
      return respond(req, rid, {
        error: "invalid_request",
        detail: parsed.error.issues[0]?.message ?? "Please check the information you entered.",
      }, 400);
    }

    const { email, password, name, locale } = parsed.data;
    requirePwPolicy(password);

    const redirectTo = new URL("/auth/callback", new URL(req.url).origin);
    redirectTo.searchParams.set("next", `/${locale}/onboarding`);

    const supabase = await supabaseServer();
    const { error } = await supabase.auth.signUp({
      email: email.toLowerCase(),
      password,
      options: {
        emailRedirectTo: redirectTo.toString(),
        data: { full_name: name ?? "" },
      },
    });

    if (error) {
      const message = error.message.toLowerCase();
      if (message.includes("already") || message.includes("registered") || message.includes("exists")) {
        return respond(req, rid, {
          message: "If this address can be registered, check your inbox for the next step.",
        }, 201);
      }
      const safeMessage = error.message.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]").slice(0, 240);
      console.error("[auth.register] Supabase sign-up failed", {
        requestId: rid,
        code: error.code,
        status: error.status,
        message: safeMessage,
      });
      return respond(req, rid, {
        error: "registration_failed",
        errorId: rid,
        detail: "We couldn't create your account. Please check your details and try again.",
      }, 400);
    }

    // Supabase may return an empty identities list for an existing address.
    // Keep the response identical to avoid revealing whether an account exists.
    // Do not return account IDs from this public endpoint.
    return respond(req, rid, {
      message: "Registration request received. If email confirmation is enabled, check your inbox for a verification link. If you don't receive one, you can try signing in.",
    }, 201);
  } catch (err) {
    if (err instanceof PasswordPolicyError) {
      return respond(req, rid, {
        error: "weak_password",
        detail: err.message,
      }, 400);
    }
    return errorResponse(err, "/v1/auth/register");
  }
}
