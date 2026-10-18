"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Clock3, FileText, Pin, Search, Trash2, PencilLine, MessageSquare, ArrowUpRight } from "lucide-react";
import { WorkspaceSidebar } from "@/components/workspace-sidebar";
import type { WorkspaceWithMembership } from "@/lib/workspaces/queries";

export interface HistoryConversation {
  id: string;
  workspaceId: string;
  userId: string;
  mode: string;
  title: string | null;
  titleAuto: boolean;
  languagePref: string | null;
  pinned: boolean;
  folderId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Props {
  locale: string;
  initialConversations: HistoryConversation[];
  workspaces: WorkspaceWithMembership[];
  activeWorkspaceId: string;
}

function modeLabel(mode: string): string {
  const labels: Record<string, string> = {
    chat: "AI Studio",
    code: "Code",
    write: "Writing",
    rewrite: "Rewrite",
    summarize: "Summarize",
    translate: "Translate",
    image: "Image prompts",
    document: "Documents",
    plan: "Planning",
  };
  return labels[mode] ?? "AI conversation";
}

function dateLabel(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

export function HistoryClient({ locale, initialConversations, workspaces, activeWorkspaceId: initialWorkspaceId }: Props) {
  const router = useRouter();
  const [conversations, setConversations] = useState(initialConversations);
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "pinned">("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const visible = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return conversations.filter((conversation) => {
      if (filter === "pinned" && !conversation.pinned) return false;
      if (!term) return true;
      return (conversation.title || modeLabel(conversation.mode)).toLocaleLowerCase().includes(term) ||
        modeLabel(conversation.mode).toLocaleLowerCase().includes(term);
    });
  }, [conversations, filter, query]);

  async function updateConversation(id: string, patch: Record<string, unknown>) {
    setBusyId(id);
    setError(null);
    try {
      const response = await fetch("/api/conversations/" + id, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const payload = await response.json().catch(() => ({})) as { data?: HistoryConversation; error?: { message?: string } | string };
      if (!response.ok) {
        const msg = typeof payload.error === "string" ? payload.error : payload.error?.message;
        throw new Error(msg || "Could not update this conversation.");
      }
      if (payload.data) {
        setConversations((current) => current.map((item) => item.id === id ? { ...item, ...payload.data } : item));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update this conversation.");
    } finally {
      setBusyId(null);
    }
  }

  async function deleteConversation(id: string) {
    if (!window.confirm("Delete this conversation and its messages? This cannot be undone.")) return;
    setBusyId(id);
    setError(null);
    try {
      const response = await fetch("/api/conversations/" + id, { method: "DELETE" });
      const payload = await response.json().catch(() => ({})) as { error?: { message?: string } | string };
      if (!response.ok) {
        const msg = typeof payload.error === "string" ? payload.error : payload.error?.message;
        throw new Error(msg || "Could not delete this conversation.");
      }
      setConversations((current) => current.filter((item) => item.id !== id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete this conversation.");
    } finally {
      setBusyId(null);
    }
  }

  function renameConversation(id: string, currentTitle: string | null) {
    const nextTitle = window.prompt("Conversation name", currentTitle || "");
    if (nextTitle === null || !nextTitle.trim()) return;
    void updateConversation(id, { title: nextTitle.trim() });
  }

  return (
    <div className="flex min-h-dvh bg-[#f6f7fb] text-slate-950">
      <WorkspaceSidebar
        locale={locale}
        workspaces={workspaces}
        activeWorkspaceId={workspaceId}
        activePage="history"
        onWorkspaceChange={setWorkspaceId}
        onNewChat={() => {
          const workspace = workspaces.find((item) => item.id === workspaceId) ?? workspaces[0];
          if (!workspace) {
            setError("Create or join a workspace before starting a conversation.");
            return;
          }
          setBusyId("new");
          void fetch("/api/conversations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workspaceId: workspace.id, mode: "chat", languagePref: locale }),
          }).then(async (response) => {
            const payload = await response.json().catch(() => ({})) as { data?: { id?: string }; error?: { message?: string } | string };
            if (!response.ok || !payload.data?.id) throw new Error("Could not start a new chat.");
            router.push("/" + locale + "/chat/" + payload.data.id);
          }).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not start a new chat."))
            .finally(() => setBusyId(null));
        }}
      />
      <main className="min-w-0 flex-1 pb-24 lg:pb-8">
        <header className="sticky top-0 z-20 flex h-[72px] items-center justify-between border-b border-slate-200 bg-white/95 px-5 backdrop-blur sm:px-8">
          <div>
            <p className="text-xs font-medium text-slate-500">Your workspace</p>
            <h1 className="text-lg font-semibold tracking-tight">Conversation history</h1>
          </div>
          <span className="hidden items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-500 sm:flex">
            <Clock3 className="h-3.5 w-3.5" /> {conversations.length} saved
          </span>
        </header>

        <div className="mx-auto max-w-5xl space-y-5 px-4 py-6 sm:px-8 sm:py-8">
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <div className="flex items-start gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-violet-50 text-violet-700"><MessageSquare className="h-5 w-5" /></span>
              <div>
                <h2 className="text-base font-semibold">Pick up where you left off</h2>
                <p className="mt-1 text-sm leading-6 text-slate-500">Search previous chats, reopen work, pin important conversations, or rename them so they are easy to find.</p>
              </div>
            </div>
            <div className="mt-5 flex flex-col gap-3 sm:flex-row">
              <label className="relative min-w-0 flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search conversations…" className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 pl-9 pr-3 text-sm outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-100" />
              </label>
              <div className="flex rounded-xl border border-slate-200 bg-slate-50 p-1">
                <button type="button" onClick={() => setFilter("all")} className={"rounded-lg px-3 py-2 text-xs font-semibold " + (filter === "all" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500")}>All chats</button>
                <button type="button" onClick={() => setFilter("pinned")} className={"rounded-lg px-3 py-2 text-xs font-semibold " + (filter === "pinned" ? "bg-white text-violet-800 shadow-sm" : "text-slate-500")}>Pinned</button>
              </div>
            </div>
          </section>

          {error && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div>}

          {visible.length === 0 ? (
            <section className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center">
              <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-slate-50 text-slate-500"><FileText className="h-5 w-5" /></span>
              <h2 className="mt-4 text-base font-semibold">{query ? "No matching conversations" : filter === "pinned" ? "Nothing pinned yet" : "Your history starts here"}</h2>
              <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">{query ? "Try a different search term." : "Start an AI Studio conversation and it will appear here so you can return to it later."}</p>
            </section>
          ) : (
            <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              <ul className="divide-y divide-slate-100">
                {visible.map((conversation) => (
                  <li key={conversation.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:px-5">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-50 text-violet-700"><MessageSquare className="h-4 w-4" /></span>
                    <div className="min-w-0 flex-1">
                      <Link href={"/" + locale + "/chat/" + conversation.id} className="group inline-flex max-w-full items-center gap-1.5 truncate text-sm font-semibold text-slate-900 hover:text-violet-800">
                        <span className="truncate">{conversation.title?.trim() || modeLabel(conversation.mode) + " session"}</span>
                        <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-slate-300 group-hover:text-violet-700" />
                      </Link>
                      <p className="mt-1 text-xs text-slate-500">{modeLabel(conversation.mode)} · Updated {dateLabel(conversation.updatedAt, locale)}</p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button type="button" title={conversation.pinned ? "Unpin conversation" : "Pin conversation"} aria-label={conversation.pinned ? "Unpin conversation" : "Pin conversation"} disabled={busyId === conversation.id} onClick={() => void updateConversation(conversation.id, { pinned: !conversation.pinned })} className={"flex h-9 w-9 items-center justify-center rounded-lg border " + (conversation.pinned ? "border-violet-200 bg-violet-50 text-violet-700" : "border-slate-200 text-slate-500 hover:bg-slate-50")}><Pin className="h-4 w-4" /></button>
                      <button type="button" title="Rename" aria-label="Rename conversation" disabled={busyId === conversation.id} onClick={() => renameConversation(conversation.id, conversation.title)} className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-50"><PencilLine className="h-4 w-4" /></button>
                      <button type="button" title="Delete" aria-label="Delete conversation" disabled={busyId === conversation.id} onClick={() => void deleteConversation(conversation.id)} className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
