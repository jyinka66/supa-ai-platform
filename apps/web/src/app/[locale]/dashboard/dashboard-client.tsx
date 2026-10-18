"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  Clock3,
  Code2,
  FileText,
  Layers,
  Languages,
  ListChecks,
  MessageSquare,
  PenLine,
  Plus,
  RefreshCw,
  Sparkles,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { Mode } from "@/lib/prompts";
import type { WorkspaceWithMembership } from "@/lib/workspaces/queries";
import { WorkspaceSidebar } from "@/components/workspace-sidebar";

interface DashboardClientProps {
  locale: string;
  profile: {
    fullName: string | null;
    avatarPath: string | null;
    language: string;
  };
  workspaces: WorkspaceWithMembership[];
  activeWorkspaceId: string;
}

interface RecentConversation {
  id: string;
  workspaceId: string;
  mode: string;
  title: string | null;
  updatedAt: string | Date;
  createdAt: string | Date;
  pinned: boolean;
}

interface ToolCard {
  mode: Mode;
  title: string;
  description: string;
  icon: LucideIcon;
  tone: string;
}

const TOOLS: ToolCard[] = [
  {
    mode: "chat",
    title: "AI assistant",
    description: "Ask questions, brainstorm, and work through ideas.",
    icon: MessageSquare,
    tone: "bg-violet-50 text-violet-700 ring-violet-100",
  },
  {
    mode: "write",
    title: "Write",
    description: "Draft emails, articles, and clear, polished copy.",
    icon: PenLine,
    tone: "bg-sky-50 text-sky-700 ring-sky-100",
  },
  {
    mode: "rewrite",
    title: "Rewrite",
    description: "Improve the tone, structure, or clarity of your text.",
    icon: RefreshCw,
    tone: "bg-amber-50 text-amber-700 ring-amber-100",
  },
  {
    mode: "summarize",
    title: "Summarize",
    description: "Turn long documents and notes into key takeaways.",
    icon: BookOpen,
    tone: "bg-emerald-50 text-emerald-700 ring-emerald-100",
  },
  {
    mode: "translate",
    title: "Translate",
    description: "Translate text while keeping its meaning and tone.",
    icon: Languages,
    tone: "bg-rose-50 text-rose-700 ring-rose-100",
  },
  {
    mode: "code",
    title: "Code helper",
    description: "Develop, explain, and troubleshoot code.",
    icon: Code2,
    tone: "bg-indigo-50 text-indigo-700 ring-indigo-100",
  },
  {
    mode: "document",
    title: "Documents",
    description: "Build structured reports, proposals, and briefs.",
    icon: FileText,
    tone: "bg-orange-50 text-orange-700 ring-orange-100",
  },
  {
    mode: "plan",
    title: "Make a plan",
    description: "Break a goal into practical, ordered next steps.",
    icon: ListChecks,
    tone: "bg-teal-50 text-teal-700 ring-teal-100",
  },
];

function modeLabel(mode: string): string {
  return TOOLS.find((tool) => tool.mode === mode)?.title ?? "Conversation";
}

function formatDate(value: string | Date, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(date);
}

export function DashboardClient({ locale, profile, workspaces, activeWorkspaceId: initialWorkspaceId }: DashboardClientProps) {
  const router = useRouter();
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(initialWorkspaceId || workspaces[0]?.id || "");
  const [recentConversations, setRecentConversations] = useState<RecentConversation[]>([]);
  const [pinnedConversations, setPinnedConversations] = useState<RecentConversation[]>([]);
  const [studioPrompt, setStudioPrompt] = useState("");
  const [studioMode, setStudioMode] = useState<Mode>("chat");
  const [loadingRecent, setLoadingRecent] = useState(true);
  const [recentError, setRecentError] = useState(false);
  const [busyMode, setBusyMode] = useState<Mode | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? workspaces[0],
    [activeWorkspaceId, workspaces],
  );

  const displayName = profile.fullName?.trim() || "there";
  const initials = (profile.fullName ?? "S")
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  useEffect(() => {
    let mounted = true;

    async function loadRecentConversations() {
      setLoadingRecent(true);
      try {
        const response = await fetch("/api/conversations", { cache: "no-store" });
        const payload = (await response.json().catch(() => ({}))) as {
          data?: RecentConversation[];
          error?: { message?: string };
        };
        if (!response.ok) throw new Error(payload.error?.message ?? "Could not load conversations.");
        if (mounted) {
          const conversations = Array.isArray(payload.data) ? payload.data : [];
          setRecentConversations(conversations.slice(0, 6));
          setPinnedConversations(conversations.filter((conversation) => conversation.pinned).slice(0, 4));
          setRecentError(false);
        }
      } catch {
        if (mounted) setRecentError(true);
      } finally {
        if (mounted) setLoadingRecent(false);
      }
    }

    void loadRecentConversations();
    return () => {
      mounted = false;
    };
  }, []);

  const startConversation = useCallback(
    async (mode: Mode, initialPrompt?: string) => {
      if (!activeWorkspace) {
        setActionError("You need a workspace before you can start a conversation.");
        return;
      }

      setActionError(null);
      setBusyMode(mode);

      try {
        const response = await fetch("/api/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId: activeWorkspace.id,
            mode,
            languagePref: /^[a-z]{2}(-[A-Z]{2})?$/.test(profile.language)
              ? profile.language
              : locale,
          }),
        });
        const payload = (await response.json().catch(() => ({}))) as {
          data?: { id?: string };
          error?: { message?: string };
          detail?: string;
        };

        if (!response.ok || !payload.data?.id) {
          throw new Error(payload.error?.message ?? payload.detail ?? "Could not start this tool. Please try again.");
        }

        const destination = `/${locale}/chat/${payload.data.id}`;
        if (initialPrompt?.trim()) {
          try {
            window.sessionStorage.setItem(`supa-pending-prompt:${payload.data.id}`, initialPrompt.trim());
          } catch {
            throw new Error("Your browser blocked secure prompt handoff. Your prompt is still here; please allow session storage and try again.");
          }
        }
        router.push(destination);
      } catch (error) {
        setActionError(error instanceof Error ? error.message : "Could not start this tool. Please try again.");
        setBusyMode(null);
      }
    },
    [activeWorkspace, locale, profile.language, router],
  );

  const base = `/${locale}`;

  return (
    <div id="top" className="min-h-dvh bg-[#f6f7fb] text-slate-950">
      <div className="flex min-h-dvh">
        <WorkspaceSidebar
          locale={locale}
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
          activePage="home"
          onWorkspaceChange={setActiveWorkspaceId}
          onNewChat={() => startConversation("chat")}
        />

        <div className="min-w-0 flex-1">
          <header className="sticky top-0 z-20 flex h-[72px] items-center justify-between border-b border-slate-200 bg-white/95 px-5 backdrop-blur sm:px-8">
            <div className="flex items-center gap-3">
              <Link href={base} className="flex items-center gap-2 lg:hidden" aria-label="Supa home">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-600 text-xs font-black text-white">s.</span>
                <span className="text-lg font-bold">supa<span className="text-violet-600">.</span></span>
              </Link>
              <div className="hidden lg:block">
                <p className="text-xs font-medium text-slate-500">Your workspace</p>
                <p className="text-sm font-semibold text-slate-900">Overview</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="hidden text-sm text-slate-500 sm:inline">Signed in as</span>
              {profile.avatarPath ? (
                <Image
                  src={profile.avatarPath}
                  alt=""
                  width={36}
                  height={36}
                  className="h-9 w-9 rounded-full object-cover ring-2 ring-white"
                />
              ) : (
                <div aria-hidden="true" className="flex h-9 w-9 items-center justify-center rounded-full bg-violet-600 text-xs font-bold text-white">
                  {initials}
                </div>
              )}
              <span className="max-w-[140px] truncate text-sm font-semibold text-slate-800">{profile.fullName || "Your account"}</span>
            </div>
          </header>

          <main className="mx-auto max-w-[1440px] space-y-8 px-5 py-7 pb-24 sm:px-8 sm:py-9 lg:pb-9">
            <section className="relative overflow-hidden rounded-[28px] bg-gradient-to-br from-violet-700 via-indigo-700 to-slate-900 p-7 text-white shadow-[0_24px_70px_-30px_rgba(79,70,229,0.65)] sm:p-10">
              <div className="pointer-events-none absolute -right-12 -top-24 h-72 w-72 rounded-full bg-white/10 blur-2xl" />
              <div className="pointer-events-none absolute bottom-[-110px] right-[20%] h-64 w-64 rounded-full bg-fuchsia-400/15 blur-3xl" />
              <div className="relative grid gap-8 md:grid-cols-[minmax(0,1fr)_250px] md:items-center">
                <div>
                  <div className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1.5 text-xs font-semibold text-violet-100">
                    <Sparkles className="h-3.5 w-3.5" /> YOUR AI WORKSPACE
                  </div>
                  <h1 className="mt-5 text-3xl font-semibold tracking-tight sm:text-4xl">
                    Good to have you back, {displayName}.
                  </h1>
                  <p className="mt-3 max-w-2xl text-sm leading-6 text-indigo-100 sm:text-base">
                    What would you like to get done today? Write something, solve a problem, or turn an idea into a plan.
                  </p>
                  <button
                    type="button"
                    onClick={() => void startConversation("chat")}
                    disabled={busyMode !== null || !activeWorkspace}
                    className="mt-6 inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-semibold text-violet-800 shadow-md transition hover:-translate-y-0.5 hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {busyMode === "chat" ? "Opening assistant…" : "Start a conversation"}
                    <ArrowRight className="h-4 w-4" />
                  </button>
                  {workspaces.length > 1 && (
                    <label className="mt-5 block max-w-xs text-xs font-medium text-indigo-100">
                      Start in workspace
                      <select
                        value={activeWorkspaceId}
                        onChange={(event) => setActiveWorkspaceId(event.target.value)}
                        className="mt-1.5 block w-full rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-white/50"
                      >
                        {workspaces.map((workspace) => (
                          <option key={workspace.id} value={workspace.id} className="text-slate-900">{workspace.name}</option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
                <div className="hidden rounded-2xl border border-white/15 bg-white/10 p-5 backdrop-blur md:block">
                  <div className="flex items-center justify-between">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/15">
                      <Sparkles className="h-5 w-5" />
                    </div>
                    <span className="rounded-full bg-emerald-300/15 px-2.5 py-1 text-[11px] font-semibold text-emerald-100">Ready when you are</span>
                  </div>
                  <p className="mt-5 text-sm font-semibold">{activeWorkspace?.name ?? "Your workspace"}</p>
                  <p className="mt-1 text-xs leading-5 text-indigo-100">Your work, conversations, and ideas in one place.</p>
                  <div className="mt-5 flex items-center gap-2 border-t border-white/15 pt-4 text-xs text-indigo-100">
                    <Check className="h-4 w-4 text-emerald-300" /> Personal workspace connected
                  </div>
                </div>
              </div>
            </section>

            {actionError && (
              <div role="alert" className="flex items-start justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                <span>{actionError}</span>
                <button type="button" className="font-semibold underline" onClick={() => setActionError(null)}>Dismiss</button>
              </div>
            )}

            <section aria-label="Workspace summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <SummaryCard icon={Layers} label="Workspaces" value={String(workspaces.length)} detail="Available to your account" tone="violet" />
              <SummaryCard icon={MessageSquare} label="Recent conversations" value={loadingRecent ? "…" : String(recentConversations.length)} detail="Your latest AI sessions" tone="blue" />
              <SummaryCard icon={Zap} label="Current plan" value={activeWorkspace?.plan ?? "Free"} detail="Workspace subscription" tone="amber" />
              <SummaryCard icon={Check} label="Your role" value={activeWorkspace?.workspace_members[0]?.role ?? "Member"} detail="Access level in selected workspace" tone="green" />
            </section>

            <section id="pinned" className="scroll-mt-24">
              <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.15em] text-violet-700">Keep close</p>
                  <h2 className="mt-1 text-xl font-semibold tracking-tight text-slate-950">Pinned conversations</h2>
                  <p className="mt-1 text-sm text-slate-500">Keep your important work one click away.</p>
                </div>
                <Link href={`/${locale}/history`} className="inline-flex items-center gap-1 text-xs font-semibold text-violet-700 hover:text-violet-900">Manage history <ArrowRight className="h-3.5 w-3.5" /></Link>
              </div>
              {loadingRecent ? (
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {Array.from({ length: 2 }).map((_, index) => <div key={index} className="h-24 animate-pulse rounded-2xl bg-white ring-1 ring-slate-200" />)}
                </div>
              ) : pinnedConversations.length ? (
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {pinnedConversations.map((conversation) => (
                    <Link key={conversation.id} href={`/${locale}/chat/${conversation.id}`} className="group rounded-2xl border border-violet-100 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-violet-300 hover:shadow-md">
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-50 text-violet-700"><MessageSquare className="h-4 w-4" /></span>
                        <span aria-label="Pinned" title="Pinned" className="text-xs font-semibold text-violet-500">PINNED</span>
                      </div>
                      <p className="mt-3 truncate text-sm font-semibold text-slate-900 group-hover:text-violet-800">{conversation.title?.trim() || modeLabel(conversation.mode) + " session"}</p>
                      <p className="mt-1 truncate text-xs text-slate-500">{modeLabel(conversation.mode)} · {formatDate(conversation.updatedAt ?? conversation.createdAt, locale)}</p>
                    </Link>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col gap-3 rounded-2xl border border-dashed border-slate-300 bg-white px-5 py-5 sm:flex-row sm:items-center">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-50 text-slate-500"><MessageSquare className="h-4 w-4" /></span>
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-slate-800">Nothing pinned yet</p>
                    <p className="mt-1 text-xs leading-5 text-slate-500">Pin any conversation in History to keep it visible here.</p>
                  </div>
                  <Link href={`/${locale}/history`} className="text-xs font-semibold text-violet-700 hover:text-violet-900">Open History <ArrowRight className="ml-1 inline h-3 w-3" /></Link>
                </div>
              )}
            </section>

            <section id="ai-tools" className="scroll-mt-24">
              <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.15em] text-violet-700">Supa AI Studio</p>
                  <h2 className="mt-1 text-xl font-semibold tracking-tight text-slate-950">What can we work on?</h2>
                  <p className="mt-1 text-sm text-slate-500">Chat, code, write, and plan in one conversation. You can change modes without losing the thread.</p>
                </div>
                <span className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-500">One workspace · multiple capabilities</span>
              </div>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void startConversation(studioMode, studioPrompt);
                }}
                className="overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-[0_20px_55px_-35px_rgba(15,23,42,0.3)] focus-within:border-violet-200"
              >
                <label htmlFor="dashboard-studio-prompt" className="sr-only">Ask Supa AI</label>
                <textarea
                  id="dashboard-studio-prompt"
                  value={studioPrompt}
                  onChange={(event) => setStudioPrompt(event.target.value)}
                  placeholder="Ask Supa AI anything. Describe a task, paste some code, or share an idea…"
                  rows={3}
                  maxLength={32000}
                  className="block min-h-[112px] w-full resize-y border-0 bg-transparent px-5 py-4 text-sm leading-6 text-slate-900 outline-none placeholder:text-slate-400 focus:ring-0"
                />
                <div className="flex flex-col gap-3 border-t border-slate-100 bg-slate-50/70 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <label htmlFor="dashboard-studio-mode" className="text-xs font-medium text-slate-500">Work mode</label>
                    <select
                      id="dashboard-studio-mode"
                      value={studioMode}
                      onChange={(event) => setStudioMode(event.target.value as Mode)}
                      className="h-9 max-w-full rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-100"
                    >
                      {TOOLS.map((tool) => <option key={tool.mode} value={tool.mode}>{tool.title}</option>)}
                    </select>
                    <span className="hidden text-[11px] text-slate-400 md:inline">Saved in {activeWorkspace?.name ?? "your workspace"}</span>
                  </div>
                  <button
                    type="submit"
                    disabled={busyMode !== null || !activeWorkspace}
                    className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {busyMode === studioMode ? "Opening Supa AI…" : "Ask Supa AI"}
                    <ArrowRight className="h-4 w-4" />
                  </button>
                </div>
              </form>
              <div className="mt-3 flex flex-wrap gap-2">
                {[
                  { label: "Explain a topic", prompt: "Explain this topic in simple language, with an example." },
                  { label: "Write an email", prompt: "Help me draft a clear, professional email." },
                  { label: "Debug code", prompt: "Help me debug this code. Ask me for the code or error details you need." },
                  { label: "Plan a project", prompt: "Help me turn this idea into a practical project plan with steps and milestones." },
                ].map((suggestion) => (
                  <button key={suggestion.label} type="button" onClick={() => { setStudioPrompt(suggestion.prompt); if (suggestion.label === "Debug code") setStudioMode("code"); }} className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:border-violet-200 hover:bg-violet-50 hover:text-violet-800">
                    {suggestion.label}
                  </button>
                ))}
              </div>
            </section>

            <div className="grid gap-8 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
              <section id="recent" className="scroll-mt-24 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.13em] text-slate-400">
                      <Clock3 className="h-3.5 w-3.5" /> Your activity
                    </div>
                    <h2 className="mt-2 text-lg font-semibold text-slate-950">Recent conversations</h2>
                  </div>
                  <button
                    type="button"
                    onClick={() => void startConversation("chat")}
                    disabled={busyMode !== null || !activeWorkspace}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-violet-700 disabled:opacity-60"
                  >
                    <Plus className="h-3.5 w-3.5" /> New chat
                  </button>
                </div>

                {loadingRecent ? (
                  <div className="mt-5 space-y-3" aria-label="Loading recent conversations">
                    {Array.from({ length: 3 }).map((_, index) => (
                      <div key={index} className="h-[58px] animate-pulse rounded-xl bg-slate-100" />
                    ))}
                  </div>
                ) : recentError ? (
                  <div className="mt-5 rounded-xl bg-slate-50 p-4 text-sm text-slate-600">
                    Recent conversations could not be loaded. You can still start a new one with any AI tool above.
                  </div>
                ) : recentConversations.length === 0 ? (
                  <div className="mt-5 rounded-xl border border-dashed border-slate-200 bg-slate-50/70 px-5 py-8 text-center">
                    <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-white text-violet-700 shadow-sm ring-1 ring-slate-200">
                      <MessageSquare className="h-5 w-5" />
                    </span>
                    <p className="mt-3 text-sm font-semibold text-slate-800">Your work starts here</p>
                    <p className="mx-auto mt-1 max-w-sm text-xs leading-5 text-slate-500">Start a conversation and it will appear here so you can return to it later.</p>
                    <button type="button" onClick={() => void startConversation("chat")} disabled={busyMode !== null || !activeWorkspace} className="mt-4 text-sm font-semibold text-violet-700 hover:text-violet-900">
                      Start your first chat <ArrowRight className="ml-1 inline h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <ul className="mt-4 divide-y divide-slate-100">
                    {recentConversations.map((conversation) => (
                      <li key={conversation.id}>
                        <Link
                          href={`/${locale}/chat/${conversation.id}`}
                          className="group flex items-center gap-3 rounded-xl px-2 py-3 transition hover:bg-slate-50"
                        >
                          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-50 text-violet-700 ring-1 ring-violet-100">
                            <MessageSquare className="h-4 w-4" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-semibold text-slate-800 group-hover:text-violet-800">
                              {conversation.title?.trim() || `${modeLabel(conversation.mode)} session`}
                            </span>
                            <span className="mt-1 block text-xs text-slate-500">{modeLabel(conversation.mode)}</span>
                          </span>
                          <span className="shrink-0 text-xs text-slate-400">{formatDate(conversation.updatedAt ?? conversation.createdAt, locale)}</span>
                          <ArrowUpRight className="h-4 w-4 shrink-0 text-slate-300 group-hover:text-violet-700" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section id="workspaces" className="scroll-mt-24 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.13em] text-slate-400">
                      <Layers className="h-3.5 w-3.5" /> Team and projects
                    </div>
                    <h2 className="mt-2 text-lg font-semibold text-slate-950">My workspaces</h2>
                  </div>
                  <span className="rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs font-semibold text-slate-600">{workspaces.length}</span>
                </div>

                {workspaces.length === 0 ? (
                  <p className="mt-5 rounded-xl bg-slate-50 p-4 text-sm text-slate-600">No workspaces are connected to this account yet.</p>
                ) : (
                  <ul className="mt-4 space-y-3">
                    {workspaces.map((workspace) => {
                      const active = workspace.id === activeWorkspace?.id;
                      const role = workspace.workspace_members[0]?.role ?? "member";
                      return (
                        <li key={workspace.id}>
                          <button
                            type="button"
                            onClick={() => setActiveWorkspaceId(workspace.id)}
                            className={`w-full rounded-xl border p-4 text-left transition ${active ? "border-violet-200 bg-violet-50/70 ring-1 ring-violet-100" : "border-slate-200 hover:border-slate-300 hover:bg-slate-50"}`}
                          >
                            <span className="flex items-start justify-between gap-3">
                              <span className="flex min-w-0 items-center gap-3">
                                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white text-violet-700 ring-1 ring-slate-200">
                                  <Layers className="h-4 w-4" />
                                </span>
                                <span className="min-w-0">
                                  <span className="block truncate text-sm font-semibold text-slate-900">{workspace.name}</span>
                                  <span className="mt-1 block text-xs text-slate-500">{workspace.is_personal ? "Personal workspace" : `/${workspace.slug}`}</span>
                                </span>
                              </span>
                              <span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${active ? "bg-violet-100 text-violet-800" : "bg-slate-100 text-slate-600"}`}>{active ? "Selected" : role}</span>
                            </span>
                            <span className="mt-3 flex items-center justify-between border-t border-slate-200/70 pt-3 text-xs text-slate-500">
                              <span>Plan: {workspace.plan}</span>
                              <span className="inline-flex items-center gap-1 font-semibold text-violet-700">{active ? "Using this workspace" : "Use workspace"} <ArrowRight className="h-3 w-3" /></span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <p className="mt-4 text-xs leading-5 text-slate-400">New conversations are saved to the selected workspace.</p>
              </section>
            </div>

            <footer className="flex flex-col gap-3 border-t border-slate-200 py-5 text-xs text-slate-400 sm:flex-row sm:items-center sm:justify-between">
              <span>© {new Date().getFullYear()} Supa. Your work, in one place.</span>
              <div className="flex items-center gap-4">
                <Link href={`/${locale}/privacy`} className="transition hover:text-slate-600">Privacy</Link>
                <Link href={`/${locale}/terms`} className="transition hover:text-slate-600">Terms</Link>
                <Link href={`/${locale}/contact`} className="transition hover:text-slate-600">Contact</Link>
              </div>
            </footer>
          </main>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  detail,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  detail: string;
  tone: "violet" | "blue" | "amber" | "green";
}) {
  const styles = {
    violet: "bg-violet-50 text-violet-700 ring-violet-100",
    blue: "bg-sky-50 text-sky-700 ring-sky-100",
    amber: "bg-amber-50 text-amber-700 ring-amber-100",
    green: "bg-emerald-50 text-emerald-700 ring-emerald-100",
  } as const;

  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-slate-500">{label}</p>
          <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">{value}</p>
        </div>
        <span className={`flex h-10 w-10 items-center justify-center rounded-xl ring-1 ${styles[tone]}`}>
          <Icon className="h-4.5 w-4.5" />
        </span>
      </div>
      <p className="mt-2 text-xs text-slate-400">{detail}</p>
    </article>
  );
}
