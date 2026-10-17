import { NextIntlClientProvider } from "next-intl";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { dir } from "@/lib/i18n/dir";
import { getMessages } from "@/lib/i18n/messages";
import { isLocale, LOCALES } from "@/lib/i18n/config";
import { Providers } from "../providers";

type Props = {
  children: ReactNode;
  params: Promise<{ locale: string }>;
};

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export default async function LocaleLayout({ children, params }: Props) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale = raw;
  const messages = await getMessages(locale);

  return (
    <html lang={locale} dir={dir(locale)} suppressHydrationWarning>
      <body className="min-h-dvh bg-surface text-text antialiased">
        <Providers>
          <NextIntlClientProvider messages={messages as never} locale={locale}>
            {children}
          </NextIntlClientProvider>
        </Providers>
      </body>
    </html>
  );
}
