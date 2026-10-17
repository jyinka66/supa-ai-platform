import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { listWorkspaces } from "@/lib/workspaces/queries";
import { DashboardClient } from "./dashboard-client";

type Props = {
  params: Promise<{ locale: string }>;
};

export default async function DashboardPage({ params }: Props) {
  const { locale } = await params;
  const supabase = await supabaseServer();

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    redirect(`/${locale}/login?next=/${locale}/dashboard`);
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("onboarding_complete, onboarding_step, full_name, avatar_path, language")
    .eq("id", session.user.id)
    .maybeSingle();

  // Resume onboarding where the user left off, unless they've finished.
  if (!profile?.onboarding_complete) {
    redirect(`/${locale}/onboarding`);
  }

  const workspaces = await listWorkspaces();

  return (
    <DashboardClient
      profile={{
        fullName: profile?.full_name ?? null,
        avatarPath: profile?.avatar_path ?? null,
        language: profile?.language ?? "en",
      }}
      workspaces={workspaces}
    />
  );
}
