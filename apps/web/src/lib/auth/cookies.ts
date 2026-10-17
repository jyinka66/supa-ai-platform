// Helper: set the refresh token in an HttpOnly, Secure, SameSite=Lax cookie.
// The cookie is scoped to path=/v1/auth — only sent to auth endpoints.
// This reduces the attack surface (the refresh token isn't sent on every
// API call — only on auth refresh/logout).

import type { NextResponse } from "next/server";

const REFRESH_COOKIE_NAME = "supa_refresh";
const SESSION_COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days (seconds).

/** Set the refresh token cookie on a NextResponse. */
export function setRefreshCookie(
  res: NextResponse | Response,
  refreshToken: string,
  secure: boolean = process.env.NODE_ENV === "production",
): void {
  const cookie = [
    `${REFRESH_COOKIE_NAME}=${refreshToken}`,
    "Path=/v1/auth",
    "HttpOnly",
    secure ? "Secure" : "",
    "SameSite=Lax",
    `Max-Age=${SESSION_COOKIE_MAX_AGE}`,
  ].filter(Boolean).join("; ");
  res.headers.set("Set-Cookie", cookie);
}

/** Clear the refresh token cookie (on logout). */
export function clearRefreshCookie(
  res: NextResponse | Response,
): void {
  const cookie = [
    `${REFRESH_COOKIE_NAME}=`,
    "Path=/v1/auth",
    "HttpOnly",
    "Max-Age=0",
    "SameSite=Lax",
  ].join("; ");
  res.headers.set("Set-Cookie", cookie);
}

/** Read the refresh token from the cookie header. */
export function readRefreshCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`${REFRESH_COOKIE_NAME}=([^;]+)`));
  return match?.[1] ?? null;
}

export { REFRESH_COOKIE_NAME };
