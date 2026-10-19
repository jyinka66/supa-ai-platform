import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { listWorkspaces } from "@/lib/workspaces/queries";
import { getActiveWorkspaceId } from "@/lib/workspaces/active";
import { TeamClient } from "./team-client";

type Props = { params: Promise<{ locale: string }> };

export default async function TeamPage({ params }: Props) {
  const { locale } = await params;
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/${locale}/login?next=/${locale}/team`);

  const workspaces = await listWorkspaces();
  const activeWorkspaceId = await getActiveWorkspaceId(workspaces);

  return (
    <TeamClient
      locale={locale}
      currentUserId={user.id}
      workspaces={workspaces}
      activeWorkspaceId={activeWorkspaceId}
    />
  );
}
