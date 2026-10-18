import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { LOCALES, DEFAULT_LOCALE, isLocale } from "@/lib/i18n/config";

/** Send visitors to the public, localized landing page. */
export default async function RootPage() {
  const cookieStore = await cookies();
  const headerList = await headers();

  const locale =
    resolveFromCookie(cookieStore) ??
    resolveFromAcceptLanguage(headerList) ??
    DEFAULT_LOCALE;

  redirect(`/${locale}`);
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
