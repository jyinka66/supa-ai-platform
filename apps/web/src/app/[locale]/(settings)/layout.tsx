import type { ReactNode } from "react";
import Link from "next/link";

type Props = {
  children: ReactNode;
  params: Promise<{ locale: string }>;
};

/**
 * Settings layout — left-rail nav + content slot.
 *
 * Nav links are localized; the AAL2 middleware gate covers `/security` so
 * users without MFA are redirected to `/m/challenge` before reaching here.
 */
export default async function SettingsLayout({ children, params }: Props) {
  const { locale } = await params;
  const links = [
    { href: `/${locale}/settings/profile`, label: "Profile" },
    { href: `/${locale}/settings/security/sessions`, label: "Sessions" },
    { href: `/${locale}/settings/billing`, label: "Billing" },
    { href: `/${locale}/settings/workspaces`, label: "Workspaces" },
  ];

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6 md:flex-row">
      <nav aria-label="Settings" className="md:w-48">
        <ul className="space-y-1">
          {links.map((l) => (
            <li key={l.href}>
              <Link
                href={l.href}
                className="block rounded-md px-3 py-2 text-sm font-medium text-textMuted transition hover:bg-surfaceMuted hover:text-text"
              >
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <main className="flex-1">{children}</main>
    </div>
  );
}
