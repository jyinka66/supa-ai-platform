import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { getConversation, getMessages } from "@/lib/chat/queries";
import { ChatClient } from "./chat-client";

type Props = {
  params: Promise<{ locale: string; conversationId: string }>;
};

export default async function ChatPage({ params }: Props) {
  const { locale, conversationId } = await params;
  const supabase = await supabaseServer();

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    redirect(`/${locale}/login?next=/${locale}/chat/${conversationId}`);
  }

  let conversation;
  try {
    conversation = await getConversation(conversationId, session.user.id);
  } catch (err) {
    const code = (err as Error).message;
    if (code === "not_found" || code === "forbidden") {
      redirect(`/${locale}/dashboard`);
    }
    throw err;
  }

  const messages = await getMessages(conversationId, 100);

  return (
    <ChatClient
      conversation={conversation}
      initialMessages={messages}
      locale={locale}
    />
  );
}
