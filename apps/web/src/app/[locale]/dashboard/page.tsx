import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { listWorkspaces } from "@/lib/workspaces/queries";
import { getActiveWorkspaceId } from "@/lib/workspaces/active";
import { DashboardClient } from "./dashboard-client";

type Props = {
  params: Promise<{ locale: string }>;
};

export default async function DashboardPage({ params }: Props) {
  const { locale } = await params;
  const supabase = await supabaseServer();

  // getUser() validates the token with Supabase Auth; getSession() only reads
  // the cookie and must not be trusted on the server.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect(`/${locale}/login?next=/${locale}/dashboard`);
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, avatar_path, language")
    .eq("id", user.id)
    .maybeSingle();

  const workspaces = await listWorkspaces();
  const activeWorkspaceId = await getActiveWorkspaceId(workspaces);

  return (
    <DashboardClient
      locale={locale}
      profile={{
        fullName: profile?.full_name ?? null,
        avatarPath: profile?.avatar_path ?? null,
        language: profile?.language ?? "en",
      }}
      workspaces={workspaces}
      activeWorkspaceId={activeWorkspaceId}
    />
  );
}
