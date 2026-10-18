"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Clock3,
  Home,
  Layers,
  LoaderCircle,
  MessageSquarePlus,
  Sparkles,
  Zap,
} from "lucide-react";
import type { WorkspaceWithMembership } from "@/lib/workspaces/queries";

export type WorkspaceNavPage = "home" | "studio" | "history";

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

  const selectedWorkspace =
    props.workspaces.find((workspace) => workspace.id === selectedId) ??
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
            <Link href={base + "/dashboard"} className={navClass(props.activePage === "home")}>
              <Home className="h-4 w-4" /> Home
            </Link>
            {props.conversationId ? (
              <Link href={base + "/chat/" + props.conversationId} className={navClass(props.activePage === "studio")}>
                <Sparkles className="h-4 w-4" /> AI Studio
              </Link>
            ) : (
              <button type="button" onClick={() => void createNewChat()} className={navClass(props.activePage === "studio")}>
                <Sparkles className="h-4 w-4" /> AI Studio
              </button>
            )}
            <Link href={base + "/history"} className={navClass(props.activePage === "history")}>
              <Clock3 className="h-4 w-4" /> History
            </Link>
          </nav>
        </div>

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
                value={selectedId}
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

      <nav aria-label="Mobile navigation" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-3 border-t border-slate-200 bg-white/95 px-3 pb-[max(8px,env(safe-area-inset-bottom))] pt-2 shadow-[0_-8px_20px_-18px_rgba(15,23,42,0.4)] backdrop-blur lg:hidden">
        <Link href={base + "/dashboard"} className={"flex flex-col items-center justify-center gap-1 rounded-lg py-1.5 text-[10px] " + (props.activePage === "home" ? "font-semibold text-violet-700" : "text-slate-500")}>
          <Home className="h-4 w-4" /> Home
        </Link>
        <button type="button" onClick={() => void createNewChat()} disabled={creatingChat || savingWorkspace || !selectedWorkspace} className="flex flex-col items-center justify-center gap-1 rounded-lg py-1.5 text-[10px] font-semibold text-violet-700 disabled:opacity-50">
          {creatingChat ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <MessageSquarePlus className="h-4 w-4" />} New chat
        </button>
        <Link href={base + "/history"} className={"flex flex-col items-center justify-center gap-1 rounded-lg py-1.5 text-[10px] " + (props.activePage === "history" ? "font-semibold text-violet-700" : "text-slate-500")}>
          <Clock3 className="h-4 w-4" /> History
        </Link>
      </nav>
    </>
  );
}
