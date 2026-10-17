import { NextIntlClientProvider } from "next-intl";
import { dir } from "@/lib/i18n/dir";
import { getMessages } from "@/lib/i18n/messages";
import type { Locale } from "@/lib/i18n/config";
import type { ReactNode } from "react";

type Props = {
  children: ReactNode;
  params: Promise<{ locale: string }>;
};

export default async function OnboardingLayout({ children, params }: Props) {
  const { locale } = await params;
  const safeLocale: Locale = (["en", "ar", "fr", "es", "de", "pt", "zh", "ja", "ko", "hi"] as const).includes(
    locale as Locale,
  )
    ? (locale as Locale)
    : "en";
  const messages = await getMessages(safeLocale);

  return (
    <NextIntlClientProvider messages={messages as never} locale={safeLocale}>
      <main dir={dir(safeLocale)} className="min-h-dvh flex items-center justify-center bg-surface">
        <div className="w-full max-w-md p-6">{children}</div>
      </main>
    </NextIntlClientProvider>
  );
}
