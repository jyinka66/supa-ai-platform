import { NextResponse, type NextRequest } from "next/server";

const LOCALES = ["en", "ar", "fr", "es", "de", "pt", "zh", "ja", "ko", "hi"] as const;
const DEFAULT_LOCALE = "en";
const AAL2_REQUIRED = ["/security", "/admin", "/workspaces/settings"];

const isDev = process.env.NODE_ENV === "development";

/**
 * Build a request-scoped CSP. Next.js reads the nonce from the request CSP
 * header and applies it to its framework and streamed RSC scripts. The
 * configured Supabase origin is included for browser auth/realtime and storage;
 * no arbitrary external origin is allowed.
 */
function getSupabaseOrigin(): string | undefined {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function buildCsp(nonce: string, supabaseOrigin?: string): string {
  const supabaseSocketOrigin = supabaseOrigin
    ?.replace(/^https:/, "wss:")
    .replace(/^http:/, "ws:");
  const connectOrigins = [
    "'self'",
    "https://*.upstash.io",
    "https://eu.i.posthog.com",
    supabaseOrigin,
    supabaseSocketOrigin,
  ].filter((origin): origin is string => Boolean(origin));

  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""} https://eu.i.posthog.com`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${supabaseOrigin ? ` ${supabaseOrigin}` : ""}`,
    "font-src 'self'",
    `connect-src ${connectOrigins.join(" ")}`,
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    isDev ? "" : "upgrade-insecure-requests",
  ]
    .filter(Boolean)
    .join("; ");
}

/**
 * Validate incoming x-trace-id (must be a UUID) — reject anything malformed
 * to prevent log poisoning and trace-ID spoofing.
 */
function resolveTraceId(incoming: string | null): string {
  if (incoming && /^[a-f0-9-]{36}$/i.test(incoming)) {
    return incoming;
  }
  return crypto.randomUUID();
}

/**
 * Negotiate locale: cookie → Accept-Language (first matching tag) → default.
 * Always returns a value from LOCALES, never an untrusted user string.
 */
function negotiateLocale(req: NextRequest): string {
  const cookie = req.cookies.get("locale")?.value;
  if (cookie && (LOCALES as readonly string[]).includes(cookie)) {
    return cookie;
  }

  const al = req.headers.get("accept-language") ?? "";
  for (const part of al.split(",")) {
    const tag = part.trim().split(";")[0]?.split("-")[0]?.toLowerCase();
    if (tag && (LOCALES as readonly string[]).includes(tag)) {
      return tag;
    }
  }
  return DEFAULT_LOCALE;
}

/**
 * Strip the locale prefix from a pathname so AAL gates match
 * localized routes (e.g. /ar/admin → /admin).
 */
function stripLocalePrefix(pathname: string): string {
  const match = pathname.match(/^\/([a-z]{2})(?=\/|$)/i);
  if (match && (LOCALES as readonly string[]).includes(match[1]!.toLowerCase())) {
    return pathname.slice(match[0].length) || "/";
  }
  return pathname;
}

export async function middleware(req: NextRequest) {
  const traceId = resolveTraceId(req.headers.get("x-trace-id"));
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce, getSupabaseOrigin());
  const { pathname } = req.nextUrl;
  const pathWithoutLocale = stripLocalePrefix(pathname);

  const locale = negotiateLocale(req);

  // AAL2 gate for privileged surfaces. Never trust the client-controlled
  // sb-aal cookie as proof of MFA; verify the live Supabase session.
  if (AAL2_REQUIRED.some((p) => pathWithoutLocale === p || pathWithoutLocale.startsWith(`${p}/`))) {
    let aal2 = false;
    try {
      const { createServerClient } = await import("@supabase/ssr");
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      if (!supabaseUrl || !supabaseAnonKey) throw new Error("Supabase session verification is not configured");
      const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
        cookies: { getAll: () => req.cookies.getAll(), setAll: () => {} },
      });
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        aal2 = !error && data?.currentLevel === "aal2";
      }
    } catch {
      // Fail closed when the session assurance cannot be verified.
      aal2 = false;
    }
    if (!aal2) {
      const response = NextResponse.redirect(
        new URL(`/${locale}/m/challenge?next=${encodeURIComponent(pathname)}`, req.url),
      );
      response.headers.set("Content-Security-Policy", csp);
      return response;
    }
  }

  // CSRF check for state-changing methods — verify Origin header.
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    const origin = req.headers.get("origin");
    const host = req.headers.get("host");
    if (!origin || !host || new URL(origin).host !== host) {
      const response = NextResponse.json(
        { error: "CSRF: invalid origin" },
        { status: 403 },
      );
      response.headers.set("Content-Security-Policy", csp);
      return response;
    }
  }

  // Provide the nonce in the request CSP header so Next.js can attach it to
  // framework/RSC scripts, and mirror it as x-nonce for application code.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("Content-Security-Policy", csp);
  requestHeaders.set("x-nonce", nonce);
  const res = NextResponse.next({ request: { headers: requestHeaders } });

  // ============ Trace ID + locale (existing) ============
  // Echo the request ID via both headers so clients + log drains can pick
  // whichever they prefer. X-Request-Id is the standard; x-trace-id is
  // our internal name (kept for backwards compatibility).
  res.headers.set("x-trace-id", traceId);
  res.headers.set("x-request-id", traceId);
  res.headers.set("x-locale", locale);
  res.headers.set("x-dir", locale === "ar" ? "rtl" : "ltr");

  // ============ Security headers (from CSP middleware spec) ============
  res.headers.set("Content-Security-Policy", csp);
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );

  // Share pages: prevent indexing of public-but-unlisted content.
  // The share route is at /api/share/[token], but the public viewer UI
  // (if we build one) would be at /s/[token].
  if (pathname.startsWith("/s/")) {
    res.headers.set("X-Robots-Tag", "noindex, nofollow");
  }

  return res;
}

export const config = {
  // Match everything except static assets + favicon + health check.
  // (Health check is excluded so monitoring tools can probe it without
  // going through middleware — reduces latency on that hot path.)
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/health).*)"],
};
