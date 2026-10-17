import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { LOCALES, DEFAULT_LOCALE, isLocale } from "@/lib/i18n/config";

/**
 * Root route — redirects to /<locale>/dashboard (or /<locale>/login).
 *
 * Locale resolution order (matches middleware logic):
 *   1. `locale` cookie
 *   2. `Accept-Language` header (first matching tag)
 *   3. DEFAULT_LOCALE
 *
 * This is a Server Component — default export is a React component that
 * calls `redirect()` from `next/navigation`.
 */
export default async function RootPage() {
  const cookieStore = await cookies();
  const headerList = await headers();

  const locale =
    resolveFromCookie(cookieStore) ??
    resolveFromAcceptLanguage(headerList) ??
    DEFAULT_LOCALE;

  redirect(`/${locale}/dashboard`);
}

function resolveFromCookie(
  cookieStore: Awaited<ReturnType<typeof cookies>>,
): string | undefined {
  const value = cookieStore.get("locale")?.value;
  if (value && isLocale(value)) return value;
  return undefined;
}

function resolveFromAcceptLanguage(
  headerList: Awaited<ReturnType<typeof headers>>,
): string | undefined {
  const al = headerList.get("accept-language") ?? "";
  for (const part of al.split(",")) {
    const tag = part.trim().split(";")[0]?.split("-")[0]?.toLowerCase();
    if (tag && (LOCALES as readonly string[]).includes(tag)) {
      return tag;
    }
  }
  return undefined;
}
