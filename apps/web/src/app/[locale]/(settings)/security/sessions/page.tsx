import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { SessionsClient } from "./sessions-client";

type Props = {
  params: Promise<{ locale: string }>;
};

export default async function SessionsPage({ params }: Props) {
  const { locale } = await params;
  const supabase = await supabaseServer();

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    redirect(`/${locale}/login?next=/${locale}/settings/security/sessions`);
  }

  // Fetch the user's sessions — service-role, since RLS would only see
  // the caller's rows anyway (which is what we want).
  const { data: sessions, error } = await supabase
    .from("user_sessions")
    .select("id, user_agent, ip_hash, created_at, last_active_at, revoked_at")
    .eq("user_id", session.user.id)
    .order("last_active_at", { ascending: false })
    .limit(50);

  if (error) {
    return <p className="text-sm text-danger">Failed to load sessions.</p>;
  }

  return (
    <SessionsClient
      sessions={(sessions ?? []).map((s) => ({
        id: s.id,
        userAgent: s.user_agent ?? "Unknown device",
        ipMasked: s.ip_hash ? "••••" : null,
        createdAt: s.created_at,
        lastActiveAt: s.last_active_at,
        revokedAt: s.revoked_at,
      }))}
      currentSessionId={session.access_token?.slice(0, 8) ?? null}
    />
  );
}
