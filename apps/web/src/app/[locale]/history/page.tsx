import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { listConversations } from "@/lib/chat/queries";
import { listWorkspaces } from "@/lib/workspaces/queries";
import { getActiveWorkspaceId } from "@/lib/workspaces/active";
import { HistoryClient } from "./history-client";

type Props = { params: Promise<{ locale: string }> };

export default async function HistoryPage({ params }: Props) {
  const { locale } = await params;
  const supabase = await supabaseServer();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/" + locale + "/login?next=/" + locale + "/history");

  const [conversations, workspaces] = await Promise.all([
    listConversations(session.user.id),
    listWorkspaces(),
  ]);
  const activeWorkspaceId = await getActiveWorkspaceId(workspaces);

  return (
    <HistoryClient
      locale={locale}
      initialConversations={conversations.map((conversation) => ({
        ...conversation,
        createdAt: conversation.createdAt.toISOString(),
        updatedAt: conversation.updatedAt.toISOString(),
      }))}
      workspaces={workspaces}
      activeWorkspaceId={activeWorkspaceId}
    />
  );
}
