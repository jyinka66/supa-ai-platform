"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Check,
  History,
  Layers,
  LoaderCircle,
  MessageSquare,
  MessageSquarePlus,
  Pencil,
  Pin,
  Search,
  Trash2,
  X,
  Users,
  Zap,
} from "lucide-react";
import type { WorkspaceWithMembership } from "@/lib/workspaces/queries";

export type WorkspaceNavPage = "dashboard" | "chat" | "history" | "team";

type SidebarConversation = {
  id: string;
  mode: string;
  title: string | null;
  updatedAt: string | Date;
  createdAt: string | Date;
  pinned: boolean;
};

interface WorkspaceSidebarProps {
  locale: string;
  workspaces: WorkspaceWithMembership[];
  activeWorkspaceId: string;
  activePage: WorkspaceNavPage;
  conversationId?: string;
  onWorkspaceChange?: (workspaceId: string) => void;
  onNewChat?: () => void | Promise<void>;
}

async function persistWorkspaceCookie(workspaceId: string): Promise<void> {
  const response = await fetch("/api/workspaces/active", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId }),
  });
  if (!response.ok) throw new Error("Could not save the active workspace.");
}

export function WorkspaceSidebar(props: WorkspaceSidebarProps) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState(
    props.activeWorkspaceId || props.workspaces[0]?.id || "",
  );
  const [savingWorkspace, setSavingWorkspace] = useState(false);
  const [creatingChat, setCreatingChat] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<SidebarConversation[]>([]);
  const [historySearch, setHistorySearch] = useState("");
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [busyConversationId, setBusyConversationId] = useState<string | null>(null);

  const effectiveSelectedId = props.activeWorkspaceId || selectedId;
  const selectedWorkspace =
    props.workspaces.find((workspace) => workspace.id === effectiveSelectedId) ??
    props.workspaces[0];
  const base = "/" + props.locale;

  useEffect(() => {
    if (!selectedId) return;
    void persistWorkspaceCookie(selectedId).catch((cause) => {
      setError(cause instanceof Error ? cause.message : "Could not save the active workspace.");
    });
    // Save the initial server-selected workspace once. Subsequent changes are
    // saved by saveWorkspace after the membership check succeeds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshHistory = useCallback(async () => {
    const response = await fetch("/api/conversations", { cache: "no-store" });
    const payload = await response.json().catch(() => ({})) as { data?: SidebarConversation[] };
    if (!response.ok) throw new Error("Could not load chat history.");
    const next = Array.isArray(payload.data) ? payload.data : [];
    if (props.conversationId && !next.some((item) => item.id === props.conversationId)) {
      const currentResponse = await fetch("/api/conversations/" + props.conversationId, { cache: "no-store" });
      const currentPayload = await currentResponse.json().catch(() => ({})) as { data?: SidebarConversation };
      if (currentResponse.ok && currentPayload.data) next.unshift(currentPayload.data);
    }
    setConversations(next);
  }, [props.conversationId]);

  useEffect(() => {
    if (!props.conversationId) return;
    let active = true;
    setHistoryLoading(true);
    void refreshHistory().catch(() => {
      if (active) setError("Chat history could not be refreshed. Check your connection and try again.");
    }).finally(() => {
      if (active) setHistoryLoading(false);
    });
    const onConversationUpdated = () => { void refreshHistory().catch(() => {}); };
    window.addEventListener("supa:conversation-updated", onConversationUpdated);
    return () => {
      active = false;
      window.removeEventListener("supa:conversation-updated", onConversationUpdated);
    };
  }, [props.conversationId, refreshHistory]);

  const visibleConversations = useMemo(() => {
    const query = historySearch.trim().toLocaleLowerCase();
    return conversations
      .filter((conversation) => {
        const title = conversation.title?.trim() || "New chat";
        return !query || title.toLocaleLowerCase().includes(query) || conversation.mode.toLocaleLowerCase().includes(query);
      })
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }, [conversations, historySearch]);

  async function updateConversation(conversationId: string, patch: { title?: string; pinned?: boolean }) {
    setError(null);
    setBusyConversationId(conversationId);
    try {
      const response = await fetch("/api/conversations/" + conversationId, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const payload = await response.json().catch(() => ({})) as { data?: SidebarConversation; error?: { message?: string } | string; detail?: string };
      if (!response.ok || !payload.data) {
        const message = typeof payload.error === "string" ? payload.error : payload.error?.message;
        throw new Error(message || payload.detail || "Could not update this conversation.");
      }
      const updatedConversation = payload.data;
      setConversations((previous) => previous.map((item) => item.id === conversationId ? updatedConversation : item));
      setRenamingId(null);
      window.dispatchEvent(new CustomEvent("supa:conversation-updated"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update this conversation.");
    } finally {
      setBusyConversationId(null);
    }
  }

  async function deleteConversation(conversationId: string) {
    if (!window.confirm("Delete this conversation and its messages? This cannot be undone.")) return;
    setError(null);
    setBusyConversationId(conversationId);
    try {
      const response = await fetch("/api/conversations/" + conversationId, { method: "DELETE" });
      const payload = await response.json().catch(() => ({})) as { error?: { message?: string } | string; detail?: string };
      if (!response.ok) {
        const message = typeof payload.error === "string" ? payload.error : payload.error?.message;
        throw new Error(message || payload.detail || "Could not delete this conversation.");
      }
      setConversations((previous) => previous.filter((item) => item.id !== conversationId));
      if (conversationId === props.conversationId) router.push(base + "/dashboard");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete this conversation.");
    } finally {
      setBusyConversationId(null);
    }
  }

  async function saveWorkspace(workspaceId: string) {
    setError(null);
    setSavingWorkspace(true);
    try {
      await persistWorkspaceCookie(workspaceId);
      setSelectedId(workspaceId);
      props.onWorkspaceChange?.(workspaceId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not switch workspace.");
    } finally {
      setSavingWorkspace(false);
    }
  }

  async function createNewChat() {
    if (!selectedWorkspace) {
      setError("Create or join a workspace before starting a conversation.");
      return;
    }
    if (props.onNewChat) {
      await props.onNewChat();
      return;
    }

    setError(null);
    setCreatingChat(true);
    try {
      const response = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: selectedWorkspace.id,
          mode: "chat",
          languagePref: props.locale,
        }),
      });
      const payload = await response.json().catch(() => ({})) as {
        data?: { id?: string };
        error?: { message?: string } | string;
        detail?: string;
      };
      if (!response.ok || !payload.data?.id) {
        const errorMessage = typeof payload.error === "string"
          ? payload.error
          : payload.error?.message;
        throw new Error(errorMessage || payload.detail || "Could not start a new chat.");
      }
      router.push(base + "/chat/" + payload.data.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start a new chat.");
    } finally {
      setCreatingChat(false);
    }
  }

  function navClass(isActive: boolean) {
    return "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition " +
      (isActive
        ? "bg-violet-50 font-semibold text-violet-800"
        : "font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-950");
  }

  return (
    <>
      <aside className="hidden w-64 shrink-0 flex-col border-r border-slate-200 bg-white px-4 py-5 lg:flex">
        <Link href={base + "/dashboard"} className="flex items-center gap-3 px-2" aria-label="Supa home">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-600 text-sm font-black text-white shadow-sm">s.</span>
          <span className="text-xl font-bold tracking-tight text-slate-950">supa<span className="text-violet-600">.</span></span>
        </Link>

        <button
          type="button"
          onClick={() => void createNewChat()}
          disabled={creatingChat || savingWorkspace || !selectedWorkspace}
          className="mt-7 inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {creatingChat ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <MessageSquarePlus className="h-4 w-4" />}
          New chat
        </button>

        <div className="mt-8">
          <p className="px-3 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">Your workspace</p>
          <nav className="mt-3 space-y-1" aria-label="Main navigation">
            {props.conversationId ? (
              <Link href={base + "/chat/" + props.conversationId} className={navClass(props.activePage === "chat")}>
                <MessageSquare className="h-4 w-4" /> AI Chat
              </Link>
            ) : (
              <button type="button" onClick={() => void createNewChat()} className={navClass(false)}>
                <MessageSquare className="h-4 w-4" /> AI Chat
              </button>
            )}
            <Link href={base + "/team"} className={navClass(props.activePage === "team")}>
              <Users className="h-4 w-4" /> Team &amp; sharing
            </Link>
          </nav>
        </div>

        {props.conversationId && (
          <section className="mt-7 flex min-h-0 flex-1 flex-col" aria-label="AI chat history">
            <div className="flex items-center justify-between px-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">Chat history</p>
              <span className="text-[10px] tabular-nums text-slate-400">{conversations.length}</span>
            </div>
            <label className="mt-3 flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-slate-400 focus-within:border-violet-300 focus-within:ring-2 focus-within:ring-violet-100">
              <Search className="h-3.5 w-3.5 shrink-0" />
              <input value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} placeholder="Search chats" aria-label="Search chat history" className="min-w-0 w-full bg-transparent text-xs text-slate-800 outline-none placeholder:text-slate-400" />
            </label>
            <div className="mt-3 min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
              {historyLoading ? (
                <p className="px-3 py-4 text-xs text-slate-400">Loading conversations…</p>
              ) : visibleConversations.length ? visibleConversations.map((conversation) => (
                <div key={conversation.id} className={"group rounded-xl transition " + (conversation.id === props.conversationId ? "bg-violet-50 ring-1 ring-violet-100" : "hover:bg-slate-50")}>
                  <div className="flex items-start gap-1 px-2 py-2">
                    <MessageSquare className={"mt-1 h-3.5 w-3.5 shrink-0 " + (conversation.id === props.conversationId ? "text-violet-600" : "text-slate-400")} />
                    <div className="min-w-0 flex-1">
                      {renamingId === conversation.id ? (
                        <form onSubmit={(event) => { event.preventDefault(); const title = renameValue.trim(); if (title) void updateConversation(conversation.id, { title }); }} className="flex items-center gap-1">
                          <input autoFocus maxLength={200} value={renameValue} onChange={(event) => setRenameValue(event.target.value)} aria-label="Conversation title" className="min-w-0 w-full rounded-md border border-violet-200 bg-white px-1.5 py-1 text-xs outline-none focus:ring-2 focus:ring-violet-100" />
                          <button type="submit" disabled={!renameValue.trim() || busyConversationId === conversation.id} aria-label="Save title" className="rounded p-1 text-violet-700 hover:bg-violet-100 disabled:opacity-50"><Check className="h-3.5 w-3.5" /></button>
                          <button type="button" onClick={() => setRenamingId(null)} aria-label="Cancel rename" className="rounded p-1 text-slate-400 hover:bg-slate-200"><X className="h-3.5 w-3.5" /></button>
                        </form>
                      ) : (
                        <Link href={base + "/chat/" + conversation.id} aria-current={conversation.id === props.conversationId ? "page" : undefined} className={"block truncate text-xs font-medium " + (conversation.id === props.conversationId ? "text-violet-800" : "text-slate-700")}>
                          {conversation.title?.trim() || "New chat"}
                        </Link>
                      )}
                      <span className="mt-1 block truncate text-[10px] capitalize text-slate-400">{conversation.mode}{conversation.pinned ? " · Pinned" : ""}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-0.5 px-7 pb-1.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                    <button type="button" onClick={() => { setRenamingId(conversation.id); setRenameValue(conversation.title?.trim() || ""); setError(null); }} disabled={busyConversationId === conversation.id} aria-label={"Rename " + (conversation.title || "conversation")} title="Rename" className="rounded-md p-1.5 text-slate-400 hover:bg-white hover:text-violet-700 disabled:opacity-50"><Pencil className="h-3 w-3" /></button>
                    <button type="button" onClick={() => void updateConversation(conversation.id, { pinned: !conversation.pinned })} disabled={busyConversationId === conversation.id} aria-label={conversation.pinned ? "Unpin conversation" : "Pin conversation"} title={conversation.pinned ? "Unpin" : "Pin"} className={"rounded-md p-1.5 hover:bg-white disabled:opacity-50 " + (conversation.pinned ? "text-violet-700" : "text-slate-400 hover:text-violet-700")}><Pin className="h-3 w-3" /></button>
                    <button type="button" onClick={() => void deleteConversation(conversation.id)} disabled={busyConversationId === conversation.id} aria-label="Delete conversation" title="Delete" className="rounded-md p-1.5 text-slate-400 hover:bg-white hover:text-rose-600 disabled:opacity-50"><Trash2 className="h-3 w-3" /></button>
                    {busyConversationId === conversation.id && <LoaderCircle className="ml-auto h-3 w-3 animate-spin text-violet-600" />}
                  </div>
                </div>
              )) : (
                <p className="px-3 py-4 text-xs leading-5 text-slate-400">{historySearch ? "No chats match your search." : "Your conversations will appear here after you start chatting."}</p>
              )}
            </div>
          </section>
        )}

        <div className="mt-8">
          <label htmlFor="supa-workspace-select" className="px-3 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">
            Current workspace
          </label>
          {props.workspaces.length ? (
            <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-2">
              <div className="flex items-center gap-2 px-2 pb-2 pt-1">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-violet-700 ring-1 ring-slate-200">
                  <Layers className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-semibold text-slate-900">{selectedWorkspace?.name ?? "Choose workspace"}</span>
                  <span className="mt-0.5 block truncate text-[10px] text-slate-500">{selectedWorkspace?.is_personal ? "Personal workspace" : "Team workspace"}</span>
                </span>
              </div>
              <select
                id="supa-workspace-select"
                value={effectiveSelectedId}
                disabled={savingWorkspace}
                onChange={(event) => void saveWorkspace(event.target.value)}
                className="block w-full rounded-lg border border-slate-200 bg-white px-2 py-2 text-xs text-slate-700 outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-100 disabled:opacity-60"
              >
                {props.workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
                ))}
              </select>
              {savingWorkspace && <p className="px-1 pt-2 text-[10px] text-slate-500">Saving workspace…</p>}
            </div>
          ) : (
            <p className="mt-3 rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-800">No workspace is available for this account.</p>
          )}
        </div>

        <div className="mt-auto rounded-2xl border border-violet-100 bg-violet-50/70 p-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-white text-violet-700 shadow-sm">
            <Zap className="h-4 w-4" />
          </div>
          <p className="mt-3 text-sm font-semibold text-slate-900">One place to get work done</p>
          <p className="mt-1 text-xs leading-5 text-slate-600">Chat, code, write, and plan inside the same AI workspace.</p>
        </div>
        {error && <p role="alert" className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs leading-5 text-rose-800">{error}</p>}
      </aside>

      {props.conversationId && mobileHistoryOpen && (
        <div className="fixed inset-x-3 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-40 max-h-[65dvh] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl lg:hidden" role="dialog" aria-label="Chat history">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <p className="text-sm font-semibold text-slate-900">Chat history</p>
            <button type="button" onClick={() => setMobileHistoryOpen(false)} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100" aria-label="Close chat history"><X className="h-4 w-4" /></button>
          </div>
          <label className="mx-3 mt-3 flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-slate-400">
            <Search className="h-3.5 w-3.5 shrink-0" />
            <input value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} placeholder="Search chats" aria-label="Search chat history" className="min-w-0 w-full bg-transparent text-xs text-slate-800 outline-none placeholder:text-slate-400" />
          </label>
          <div className="max-h-[calc(65dvh-7rem)] overflow-y-auto p-2">
            {historyLoading ? <p className="px-3 py-5 text-center text-xs text-slate-400">Loading conversations…</p> : visibleConversations.length ? visibleConversations.map((conversation) => (
              <Link key={conversation.id} href={base + "/chat/" + conversation.id} onClick={() => setMobileHistoryOpen(false)} className={"flex items-start gap-3 rounded-xl px-3 py-3 " + (conversation.id === props.conversationId ? "bg-violet-50 text-violet-800" : "text-slate-700 hover:bg-slate-50")}>
                <MessageSquare className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{conversation.title?.trim() || "New chat"}</span><span className="mt-1 block text-xs capitalize text-slate-400">{conversation.mode}{conversation.pinned ? " · Pinned" : ""}</span></span>
              </Link>
            )) : <p className="px-3 py-5 text-center text-xs text-slate-400">{historySearch ? "No chats match your search." : "No conversations yet."}</p>}
          </div>
        </div>
      )}
      <nav aria-label="Mobile navigation" className={"fixed inset-x-0 bottom-0 z-30 grid " + (props.conversationId ? "grid-cols-3" : "grid-cols-2") + " border-t border-slate-200 bg-white/95 px-3 pb-[max(8px,env(safe-area-inset-bottom))] pt-2 shadow-[0_-8px_20px_-18px_rgba(15,23,42,0.4)] backdrop-blur lg:hidden"}>
        {props.conversationId ? (
          <Link href={base + "/chat/" + props.conversationId} className={"flex flex-col items-center justify-center gap-1 rounded-lg py-1.5 text-[10px] " + (props.activePage === "chat" ? "font-semibold text-violet-700" : "text-slate-500")}>
            <MessageSquare className="h-4 w-4" /> AI Chat
          </Link>
        ) : (
          <button type="button" onClick={() => void createNewChat()} disabled={creatingChat || savingWorkspace || !selectedWorkspace} className="flex flex-col items-center justify-center gap-1 rounded-lg py-1.5 text-[10px] font-semibold text-violet-700 disabled:opacity-50">
            {creatingChat ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <MessageSquarePlus className="h-4 w-4" />} AI Chat
          </button>
        )}
        {props.conversationId && <button type="button" onClick={() => setMobileHistoryOpen((open) => !open)} aria-expanded={mobileHistoryOpen} className={"flex flex-col items-center justify-center gap-1 rounded-lg py-1.5 text-[10px] " + (mobileHistoryOpen ? "font-semibold text-violet-700" : "text-slate-500")}><History className="h-4 w-4" /> History</button>}
        <Link href={base + "/team"} className={"flex flex-col items-center justify-center gap-1 rounded-lg py-1.5 text-[10px] " + (props.activePage === "team" ? "font-semibold text-violet-700" : "text-slate-500")}>
          <Users className="h-4 w-4" /> Team
        </Link>
      </nav>
    </>
  );
}
