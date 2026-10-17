import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Refreshes the sb-aal cookie from the current Supabase session.
 * Called client-side after sign-in / MFA verification so that
 * subsequent navigation triggers middleware with up-to-date AAL.
 */
export async function POST() {
  const supabase = await supabaseServer();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: "no_session" }, { status: 401 });
  }
  const { data: assurance, error: assuranceError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (assuranceError) {
    return NextResponse.json({ error: "assurance_unavailable" }, { status: 503 });
  }
  const aal = assurance.currentLevel ?? "aal1";
  const res = NextResponse.json({ aal });
  res.cookies.set("sb-aal", aal, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
  return res;
}
