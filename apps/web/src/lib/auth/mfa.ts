import { createClient } from "@supabase/supabase-js";
import { ApiError } from "@/lib/http/middleware";

/** Verify a valid Supabase session is at AAL2 and its auth_time is recent. */
export async function requireRecentAal2(userId: string, accessToken: string): Promise<void> {
  if (!accessToken || accessToken.length > 16_384) throw new ApiError("mfa_reauth_required", 403);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new ApiError("mfa_verification_unavailable", 503);

  const supabase = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const [{ data: userData, error: userError }, { data: assurance, error: assuranceError }] = await Promise.all([
    supabase.auth.getUser(accessToken),
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
  ]);
  if (userError || !userData.user || userData.user.id !== userId || assuranceError || assurance?.currentLevel !== "aal2") {
    throw new ApiError("mfa_reauth_required", 403, { reason: "aal2_required" });
  }

  // getUser above validates the JWT signature with Supabase Auth. Only then do
  // we read auth_time from that same verified token to enforce a 5-minute window.
  try {
    const encoded = accessToken.split(".")[1];
    if (!encoded) throw new Error("invalid_jwt");
    const claims = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { auth_time?: unknown; sub?: unknown; aal?: unknown };
    const authTime = Number(claims.auth_time);
    const now = Date.now() / 1000;
    if (claims.sub !== userId || claims.aal !== "aal2" || !Number.isFinite(authTime) || now - authTime > 300 || authTime - now > 30) {
      throw new Error("recent_aal2_required");
    }
  } catch {
    throw new ApiError("mfa_reauth_required", 403, { reason: "recent_aal2_required" });
  }
}
