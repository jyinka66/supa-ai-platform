import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { guard, guardLogin } from "@/lib/ratelimit/guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { supabaseBrowser } from "@/lib/supabase/client";
import { pino } from "@/lib/observability/logger";
import { audit } from "@/lib/audit";
import { ip as extractIp } from "@/lib/utils/ip";
import { parseBody } from "@/lib/validate";
import { signupSchema, loginSchema } from "@/lib/schemas";

/**
 * Validates an email string per RFC 5322 simplified form.
 */
function isValidEmail(email: unknown): email is string {
  return (
    typeof email === "string" &&
    email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  );
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ action: string[] }> },
) {
  const { action } = await params;
  const traceId = req.headers.get("x-trace-id") ?? "no-trace";
  const clientIp = extractIp(req);
  const log = pino.child({ traceId, route: "auth", action: action.join("/") });

  const [verb] = action;

  // ============ SIGNUP ============
  if (verb === "signup") {
    const denied = await guard(req, "authActions");
    if (denied) return denied;

    const result = await parseBody(req, signupSchema);
    if (!result.ok) return result.res;
    const { email, password, language } = result.data;

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      user_metadata: language ? { language } : undefined,
    });

    if (error) {
      log.warn({ event: "signup_failed", code: error.message });
      return NextResponse.json({ error: "signup_failed" }, { status: 400 });
    }

    log.info({ event: "signup_ok", user_id: data.user.id });
    await audit({
      actorId: data.user.id,
      actorKind: "user",
      action: "auth.signup",
      targetType: "user",
      targetId: data.user.id,
      ip: clientIp,
    });
    return NextResponse.json({ user_id: data.user.id });
  }

  // ============ LOGIN ============
  if (verb === "login") {
    const result = await parseBody(req, loginSchema);
    if (!result.ok) return result.res;
    const { email, password } = result.data;

    // Dual rate-limit: per-IP + per-(IP, email) to prevent lockout-via-spam.
    const denied = await guardLogin(req, email);
    if (denied) return denied;

    const { data, error } = await supabaseBrowser.auth.signInWithPassword({
      email,
      password,
    });

    if (error || !data.session) {
      await audit({
        actorId: null,
        actorKind: "system",
        action: "auth.login_failed",
        targetType: "user",
        targetId: email.toLowerCase(),
        metadata: { reason: error?.message ?? "unknown" },
        ip: clientIp,
      });
      return NextResponse.json(
        { error: "invalid_credentials" },
        { status: 401 },
      );
    }

    // Refresh the AAL cookie on the client side.
    await fetch("/api/auth/refresh-aal", { method: "POST" }).catch(() => {});

    await audit({
      actorId: data.user.id,
      actorKind: "user",
      action: "auth.login",
      targetType: "user",
      targetId: data.user.id,
      ip: clientIp,
    });

    return NextResponse.json({
      user_id: data.user.id,
      session: {
        access_token: data.session.access_token,
        expires_at: data.session.expires_at,
      },
    });
  }

  // ============ LOGOUT ============
  if (verb === "logout") {
    const denied = await guard(req, "default");
    if (denied) return denied;

    const { error } = await supabaseBrowser.auth.signOut();
    if (error) {
      return NextResponse.json({ error: "logout_failed" }, { status: 400 });
    }

    // Clear the AAL cookie.
    const res = NextResponse.json({ ok: true });
    res.cookies.delete("sb-aal");
    return res;
  }

  return NextResponse.json({ error: "not_found" }, { status: 404 });
}
