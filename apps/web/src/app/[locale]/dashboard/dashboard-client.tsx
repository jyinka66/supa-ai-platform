"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  ArrowRight,
  Check,
  Layers,
  LogOut,
  Sparkles,
  Zap,
  FolderOpen,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { Mode } from "@/lib/prompts";
import type { WorkspaceWithMembership } from "@/lib/workspaces/queries";
import { WorkspaceSidebar } from "@/components/workspace-sidebar";
import { WorkLibraryPanel } from "@/components/work-library-panel";
import { supabaseBrowser } from "@/lib/supabase/client";

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


export function DashboardClient({ locale, profile, workspaces, activeWorkspaceId: initialWorkspaceId }: DashboardClientProps) {
  const router = useRouter();
  const t = useTranslations("dashboard.home");
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(initialWorkspaceId || workspaces[0]?.id || "");
  const [busyMode, setBusyMode] = useState<Mode | null>(null);
  const [workStats, setWorkStats] = useState<{ items: number | null; folders: number | null }>({ items: null, folders: null });
  const [actionError, setActionError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? workspaces[0],
    [activeWorkspaceId, workspaces],
  );


  const displayName = profile.fullName?.trim() || "";
  const initials = (profile.fullName ?? "S")
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();


  const startConversation = useCallback(
    async (mode: Mode, initialPrompt?: string) => {
      if (!activeWorkspace) {
        setActionError(t("e1"));
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
          throw new Error(payload.error?.message ?? payload.detail ?? t("e2"));
        }

        const destination = `/${locale}/chat/${payload.data.id}`;
        if (initialPrompt?.trim()) {
          try {
            window.sessionStorage.setItem(`supa-pending-prompt:${payload.data.id}`, initialPrompt.trim());
          } catch {
            throw new Error(t("e3"));
          }
        }
        router.push(destination);
      } catch (error) {
        setActionError(error instanceof Error ? error.message : t("e2"));
        setBusyMode(null);
      }
    },
    [activeWorkspace, locale, profile.language, router, t],
  );

  const signOut = useCallback(async () => {
    setSigningOut(true);
    setActionError(null);
    try {
      const { error } = await supabaseBrowser.auth.signOut();
      if (error) throw error;
      router.replace(`/${locale}/login`);
      router.refresh();
    } catch {
      setActionError(t("hse"));
      setSigningOut(false);
    }
  }, [locale, router, t]);

  const base = `/${locale}`;

  return (
    <div id="top" className="min-h-dvh bg-[#f6f7fb] text-slate-950">
      <div className="flex min-h-dvh">
        <WorkspaceSidebar
          locale={locale}
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
          activePage="dashboard"
          onWorkspaceChange={setActiveWorkspaceId}
          onNewChat={() => startConversation("chat")}
        />

        <div className="min-w-0 flex-1">
          <header className="sticky top-0 z-20 flex h-[72px] items-center justify-between border-b border-slate-200 bg-white/95 px-5 backdrop-blur sm:px-8">
            <div className="flex items-center gap-3">
              <Link href={base + "/dashboard"} className="flex items-center gap-2 lg:hidden" aria-label="Supa dashboard">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-600 text-xs font-black text-white">s.</span>
                <span className="text-lg font-bold">supa<span className="text-violet-600">.</span></span>
              </Link>
              <div className="hidden lg:block">
                <p className="text-xs font-medium text-slate-500">SUPA WORKSPACE</p>
                <p className="text-sm font-semibold text-slate-900">Workspace dashboard</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="hidden text-sm text-slate-500 sm:inline">{t("hs")}</span>
              {profile.avatarPath && /^https?:\/\//.test(profile.avatarPath) ? (
                // avatar_path may hold a bare storage path, which next/image
                // cannot load without a configured host, so only absolute URLs
                // are shown and everything else falls back to initials.
                // eslint-disable-next-line @next/next/no-img-element
                <img
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
              <span className="hidden max-w-[140px] truncate text-sm font-semibold text-slate-800 sm:inline">{profile.fullName || t("ha")}</span>
              <button
                type="button"
                onClick={() => void signOut()}
                disabled={signingOut}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900 disabled:opacity-60"
              >
                <LogOut className="h-3.5 w-3.5" />
                {signingOut ? t("hsi") : t("hso")}
              </button>
            </div>
          </header>

          <main className="mx-auto max-w-[1440px] space-y-8 px-5 py-7 pb-24 sm:px-8 sm:py-9 lg:pb-9">
            <section className="relative overflow-hidden rounded-[28px] bg-gradient-to-br from-violet-700 via-indigo-700 to-slate-900 p-7 text-white shadow-[0_24px_70px_-30px_rgba(79,70,229,0.65)] sm:p-10">
              <div className="pointer-events-none absolute -right-12 -top-24 h-72 w-72 rounded-full bg-white/10 blur-2xl" />
              <div className="pointer-events-none absolute bottom-[-110px] right-[20%] h-64 w-64 rounded-full bg-fuchsia-400/15 blur-3xl" />
              <div className="relative grid gap-8 md:grid-cols-[minmax(0,1fr)_250px] md:items-center">
                <div>
                  <div className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1.5 text-xs font-semibold text-violet-100">
                    <Sparkles className="h-3.5 w-3.5" /> {t("b")}
                  </div>
                  <h1 className="mt-5 text-3xl font-semibold tracking-tight sm:text-4xl">
                    {displayName ? t("t", { name: displayName }) : t("t0")}
                  </h1>
                  <p className="mt-3 max-w-2xl text-sm leading-6 text-indigo-100 sm:text-base">
                    {t("sub")}
                  </p>
                  <button
                    type="button"
                    onClick={() => void startConversation("chat")}
                    disabled={busyMode !== null || !activeWorkspace}
                    className="mt-6 inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-semibold text-violet-800 shadow-md transition hover:-translate-y-0.5 hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {busyMode === "chat" ? t("op") : t("st")}
                    <ArrowRight className="h-4 w-4" />
                  </button>
                  {workspaces.length > 1 && (
                    <label className="mt-5 block max-w-xs text-xs font-medium text-indigo-100">
                      {t("si")}
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
                    <span className="rounded-full bg-emerald-300/15 px-2.5 py-1 text-[11px] font-semibold text-emerald-100">{t("rd")}</span>
                  </div>
                  <p className="mt-5 text-sm font-semibold">{activeWorkspace?.name ?? t("wf")}</p>
                  <p className="mt-1 text-xs leading-5 text-indigo-100">{t("tg")}</p>
                  <div className="mt-5 flex items-center gap-2 border-t border-white/15 pt-4 text-xs text-indigo-100">
                    <Check className="h-4 w-4 text-emerald-300" /> {t("cn")}
                  </div>
                </div>
              </div>
            </section>

            {actionError && (
              <div role="alert" className="flex items-start justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                <span>{actionError}</span>
                <button type="button" className="font-semibold underline" onClick={() => setActionError(null)}>{t("dm")}</button>
              </div>
            )}

            <section aria-label={t("sw")} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <SummaryCard icon={Layers} label="Saved work" value={workStats.items === null ? "—" : String(workStats.items)} detail="Items saved in this workspace" tone="violet" />
              <SummaryCard icon={FolderOpen} label="Folders" value={workStats.folders === null ? "—" : String(workStats.folders)} detail="Folders to organize your work" tone="blue" />
              <SummaryCard icon={Zap} label={t("sp")} value={activeWorkspace?.plan ?? "Free"} detail={t("spd")} tone="amber" />
              <SummaryCard icon={Check} label={t("sro")} value={activeWorkspace?.workspace_members[0]?.role ?? "member"} detail={t("srod")} tone="green" />
            </section>


            <section aria-label="Quick access">
              <div className="mb-4">
                <h2 className="text-lg font-semibold tracking-tight text-slate-950">Quick access</h2>
                <p className="mt-1 text-sm text-slate-500">Jump straight into the tools you use to get work done.</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                <Link href="#my-work" className="group flex min-h-[118px] items-start gap-3 rounded-2xl border border-slate-200 bg-white p-4 transition hover:border-violet-200 hover:shadow-sm">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sky-50 text-sky-700"><FolderOpen className="h-4.5 w-4.5" /></span>
                  <span><span className="block text-sm font-semibold text-slate-900">Work library</span><span className="mt-1 block text-xs leading-5 text-slate-500">Create, search, edit, favorite, and export saved work.</span></span>
                </Link>
                <Link href={base + "/team"} className="group flex min-h-[118px] items-start gap-3 rounded-2xl border border-slate-200 bg-white p-4 transition hover:border-violet-200 hover:shadow-sm">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700"><Users className="h-4.5 w-4.5" /></span>
                  <span><span className="block text-sm font-semibold text-slate-900">Team & sharing</span><span className="mt-1 block text-xs leading-5 text-slate-500">Invite collaborators and manage workspace access.</span></span>
                </Link>
                <Link href={base + "/security/sessions"} className="group flex min-h-[118px] items-start gap-3 rounded-2xl border border-slate-200 bg-white p-4 transition hover:border-violet-200 hover:shadow-sm">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-700"><ShieldCheck className="h-4.5 w-4.5" /></span>
                  <span><span className="block text-sm font-semibold text-slate-900">Account security</span><span className="mt-1 block text-xs leading-5 text-slate-500">Review active sessions and sign out devices you no longer use.</span></span>
                </Link>
              </div>
            </section>

            <section aria-labelledby="ai-tools-heading" className="rounded-[26px] border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.16em] text-violet-700">Get work done</p>
                  <h2 id="ai-tools-heading" className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">AI tools</h2>
                  <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500">Start a focused task. Each tool opens a real AI conversation in your selected workspace, and the task prompt is ready for you to edit or send.</p>
                </div>
                <span className="text-xs font-medium text-slate-400">8 task types · saved in AI Chat</span>
              </div>
              <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {([
                  { mode: "write", title: "Write", description: "Draft emails, articles, proposals, and polished copy.", prompt: "Help me write a clear, polished piece. Ask me for any essential context you need, then draft it." },
                  { mode: "rewrite", title: "Rewrite", description: "Improve clarity, tone, structure, or readability.", prompt: "Help me rewrite text for clarity and impact. Ask me to paste the text and specify a preferred tone if needed." },
                  { mode: "summarize", title: "Summarize", description: "Turn long notes and documents into key points.", prompt: "Help me summarize a document or notes into the main points, decisions, risks, and next actions. Ask me to provide the source text." },
                  { mode: "translate", title: "Translate", description: "Translate content while preserving meaning and tone.", prompt: "Help me translate text accurately while preserving its meaning and tone. Ask me for the text and target language." },
                  { mode: "code", title: "Code helper", description: "Build, explain, and troubleshoot code.", prompt: "Help me with a coding task. Ask for the relevant code, expected behavior, and error details if they are needed." },
                  { mode: "document", title: "Documents", description: "Create structured reports, briefs, and proposals.", prompt: "Help me create a structured document. First clarify the audience, purpose, and key points, then draft a useful document." },
                  { mode: "plan", title: "Make a plan", description: "Break a goal into ordered, actionable steps.", prompt: "Help me turn my goal into a practical plan with milestones, priorities, dependencies, and next actions. Ask what goal I want to achieve." },
                  { mode: "image", title: "Image concepts", description: "Develop detailed visual concepts and image-generation prompts.", prompt: "Help me develop an image concept and a precise image-generation prompt. Ask about the subject, style, composition, lighting, and mood if needed." },
                ] satisfies { mode: Mode; title: string; description: string; prompt: string }[]).map((tool) => (
                  <button
                    key={tool.mode}
                    type="button"
                    onClick={() => void startConversation(tool.mode, tool.prompt)}
                    disabled={busyMode !== null || !activeWorkspace}
                    className="group flex min-h-[136px] flex-col rounded-2xl border border-slate-200 bg-white p-4 text-left transition hover:-translate-y-0.5 hover:border-violet-300 hover:bg-violet-50/40 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className="flex w-full items-center justify-between gap-3">
                      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-50 text-violet-700 transition group-hover:bg-white"><Sparkles className="h-4.5 w-4.5" /></span>
                      <ArrowRight className="h-4 w-4 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-violet-700" />
                    </span>
                    <span className="mt-4 block text-sm font-semibold text-slate-900">{busyMode === tool.mode ? "Opening…" : tool.title}</span>
                    <span className="mt-1 block text-xs leading-5 text-slate-500">{tool.description}</span>
                  </button>
                ))}
              </div>
              {actionError && <p role="alert" className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{actionError}</p>}
            </section>

            {activeWorkspace && <WorkLibraryPanel workspaceId={activeWorkspace.id} onStatsChange={setWorkStats} />}

            <div className="grid gap-8">
              <section id="workspaces" className="scroll-mt-24 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.13em] text-slate-400">
                      <Layers className="h-3.5 w-3.5" /> {t("we")}
                    </div>
                    <h2 className="mt-2 text-lg font-semibold text-slate-950">{t("wt")}</h2>
                  </div>
                  <span className="rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs font-semibold text-slate-600">{workspaces.length}</span>
                </div>

                {workspaces.length === 0 ? (
                  <p className="mt-5 rounded-xl bg-slate-50 p-4 text-sm text-slate-600">{t("wn")}</p>
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
                                  <span className="mt-1 block text-xs text-slate-500">{workspace.is_personal ? t("wp") : `/${workspace.slug}`}</span>
                                </span>
                              </span>
                              <span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${active ? "bg-violet-100 text-violet-800" : "bg-slate-100 text-slate-600"}`}>{active ? t("wse") : role}</span>
                            </span>
                            <span className="mt-3 flex items-center justify-between border-t border-slate-200/70 pt-3 text-xs text-slate-500">
                              <span>{t("wpl", { plan: workspace.plan })}</span>
                              <span className="inline-flex items-center gap-1 font-semibold text-violet-700">{active ? t("wus") : t("wu")} <ArrowRight className="h-3 w-3" /></span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <p className="mt-4 text-xs leading-5 text-slate-400">{t("wno")}</p>
              </section>
            </div>

            <footer className="flex flex-col gap-3 border-t border-slate-200 py-5 text-xs text-slate-400 sm:flex-row sm:items-center sm:justify-between">
              <span>{t("ft", { year: new Date().getFullYear() })}</span>
              <div className="flex items-center gap-4">
                <Link href={`/${locale}/privacy`} className="transition hover:text-slate-600">{t("fp")}</Link>
                <Link href={`/${locale}/terms`} className="transition hover:text-slate-600">{t("ftm")}</Link>
                <Link href={`/${locale}/contact`} className="transition hover:text-slate-600">{t("fc")}</Link>
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
