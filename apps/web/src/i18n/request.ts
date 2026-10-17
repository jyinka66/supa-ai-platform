import { getRequestConfig } from "next-intl/server";
import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/config";
import { getMessages } from "@/lib/i18n/messages";

/**
 * next-intl request config. Required by the server version of
 * NextIntlClientProvider (used in the [locale] and onboarding layouts), even
 * when locale and messages are passed to the provider explicitly.
 * Registered in next.config.mjs via createNextIntlPlugin.
 */
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = isLocale(requested) ? requested : DEFAULT_LOCALE;
  return {
    locale,
    messages: (await getMessages(locale)) as Record<string, never>,
  };
});
