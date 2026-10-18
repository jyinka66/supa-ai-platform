import { redirect } from "next/navigation";

type Props = {
  params: Promise<{ locale: string }>;
};

/**
 * Onboarding is optional and no longer blocks the first dashboard visit.
 * Keep this route as a compatibility redirect for existing email links and
 * bookmarks that still point to /onboarding.
 */
export default async function OnboardingPage({ params }: Props) {
  const { locale } = await params;
  redirect(`/${locale}/dashboard`);
}
