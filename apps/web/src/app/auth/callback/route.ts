import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Supabase OAuth/magic-link callback. Exchanges `code` for session,
 * then sets an advisory `sb-aal` cookie. Privileged routes verify AAL2
 * against the live Supabase session and never trust this cookie as proof.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const nextRaw = url.searchParams.get("next") ?? "/dashboard";

  // Validate `next` — must be a relative path (start with /) to prevent
  // open-redirect attacks (e.g. ?next=https://evil.example.com).
  const next = nextRaw.startsWith("/") && !nextRaw.startsWith("//")
    ? nextRaw
    : "/dashboard";

  if (!code) {
    return NextResponse.redirect(new URL("/login?error=missing_code", req.url));
  }

  const supabase = await supabaseServer();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(new URL(`/login?error=${error.message}`, req.url));
  }

  const { data: { user } } = await supabase.auth.getUser();
  const { data: assurance, error: assuranceError } = user
    ? await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    : { data: null, error: null };

  // Advisory UI cookie only; middleware independently verifies the session.
  const aal = !assuranceError ? assurance?.currentLevel ?? "aal1" : "aal1";
  const res = NextResponse.redirect(new URL(next, req.url));
  // HttpOnly=true: middleware (NextRequest.cookies) and route handlers
  // (next/headers cookies()) can still read this, but browser JS cannot.
  // This prevents client-side scripts from inspecting or forging the AAL state.
  res.cookies.set("sb-aal", aal, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7, // 7 days, matches Supabase session default
  });
  return res;
}
