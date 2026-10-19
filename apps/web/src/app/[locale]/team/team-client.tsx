"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { BadgeCheck, LoaderCircle, Mail, Plus, Trash2, UserMinus, Users } from "lucide-react";
import { WorkspaceSidebar } from "@/components/workspace-sidebar";
import type { WorkspaceRole, WorkspaceWithMembership } from "@/lib/workspaces/queries";

interface Props {
  locale: string;
  currentUserId: string;
  workspaces: WorkspaceWithMembership[];
  activeWorkspaceId: string;
}

interface Member {
  userId: string;
  role: WorkspaceRole;
  fullName: string | null;
  isVerified: boolean | null;
  createdAt: string;
}

type Notice = { kind: "error" | "success"; text: string };

const ASSIGNABLE_ROLES = ["admin", "member", "viewer"] as const;

const ROLE_HELP: Record<WorkspaceRole, string> = {
  owner: "Full control of the workspace",
  admin: "Manage members and settings",
  member: "Create and edit work",
  viewer: "Read-only access",
};

function apiMessage(payload: unknown, fallback: string): string {
  const body = payload as { error?: { message?: string; code?: string } | string; detail?: string } | null;
  if (!body) return fallback;
  if (typeof body.error === "string") return friendlyCode(body.error) ?? body.detail ?? fallback;
  return body.error?.message ?? friendlyCode(body.error?.code) ?? body.detail ?? fallback;
}

function friendlyCode(code: string | undefined): string | null {
  switch (code) {
    case "seats_full":
      return "This workspace has no free seats left.";
    case "invite_exists":
      return "That person already has a pending invite.";
    case "slug_taken":
      return "That workspace address is already taken.";
    case "forbidden":
      return "You do not have permission to do that.";
    case "rate_limited":
      return "Too many attempts. Please wait a moment and try again.";
    case "cannot_remove_owner":
    case "cannot_change_owner_role":
      return "The owner of a workspace cannot be changed or removed.";
    default:
      return null;
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function joinedLabel(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

export function TeamClient({ locale, currentUserId, workspaces, activeWorkspaceId: initialWorkspaceId }: Props) {
  const router = useRouter();
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId || workspaces[0]?.id || "");
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busyUser, setBusyUser] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<(typeof ASSIGNABLE_ROLES)[number]>("member");
  const [inviting, setInviting] = useState(false);

  const [newName, setNewName] = useState("");
  const [newSlug, setNewSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [creating, setCreating] = useState(false);

  const workspace = useMemo(
    () => workspaces.find((item) => item.id === workspaceId) ?? workspaces[0],
    [workspaceId, workspaces],
  );
  const myRole: WorkspaceRole | null = workspace?.workspace_members[0]?.role ?? null;
  const canManage = myRole === "owner" || myRole === "admin";

  const loadMembers = useCallback(async (id: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch(`/api/workspaces/${id}/members`, { cache: "no-store" });
      const payload = (await response.json().catch(() => null)) as { data?: { members?: Member[] } } | null;
      if (!response.ok) throw new Error(apiMessage(payload, "Could not load members."));
      setMembers(Array.isArray(payload?.data?.members) ? payload.data.members : []);
    } catch (error) {
      setMembers([]);
      setLoadError(error instanceof Error ? error.message : "Could not load members.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (workspace?.id) void loadMembers(workspace.id);
  }, [workspace?.id, loadMembers]);

  async function changeRole(member: Member, role: string) {
    if (!workspace) return;
    setNotice(null);
    setBusyUser(member.userId);
    try {
      const response = await fetch(`/api/workspaces/${workspace.id}/members/${member.userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiMessage(payload, "Could not change that role."));
      setMembers((current) =>
        current.map((item) => (item.userId === member.userId ? { ...item, role: role as WorkspaceRole } : item)),
      );
      setNotice({ kind: "success", text: "Role updated." });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Could not change that role." });
    } finally {
      setBusyUser(null);
    }
  }

  async function removeMember(member: Member) {
    if (!workspace) return;
    const self = member.userId === currentUserId;
    const question = self
      ? `Leave ${workspace.name}? You will lose access to its conversations.`
      : `Remove ${member.fullName?.trim() || "this member"} from ${workspace.name}?`;
    if (!window.confirm(question)) return;

    setNotice(null);
    setBusyUser(member.userId);
    try {
      const response = await fetch(`/api/workspaces/${workspace.id}/members/${member.userId}`, { method: "DELETE" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiMessage(payload, "Could not remove that member."));
      if (self) {
        router.replace(`/${locale}/dashboard`);
        router.refresh();
        return;
      }
      setMembers((current) => current.filter((item) => item.userId !== member.userId));
      setNotice({ kind: "success", text: "Member removed." });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Could not remove that member." });
    } finally {
      setBusyUser(null);
    }
  }

  async function sendInvite(event: React.FormEvent) {
    event.preventDefault();
    if (!workspace) return;
    setNotice(null);
    setInviting(true);
    try {
      const response = await fetch("/api/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: workspace.id, email: inviteEmail.trim(), role: inviteRole }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiMessage(payload, "Could not send the invite."));
      setNotice({ kind: "success", text: `Invite sent to ${inviteEmail.trim().toLowerCase()}. It expires in 7 days.` });
      setInviteEmail("");
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Could not send the invite." });
    } finally {
      setInviting(false);
    }
  }

  async function createWorkspace(event: React.FormEvent) {
    event.preventDefault();
    setNotice(null);
    setCreating(true);
    try {
      const response = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), slug: newSlug }),
      });
      const payload = (await response.json().catch(() => null)) as { data?: { id?: string } } | null;
      if (!response.ok || !payload?.data?.id) throw new Error(apiMessage(payload, "Could not create the workspace."));

      // Make the new workspace the active one, then reload server data.
      await fetch("/api/workspaces/active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: payload.data.id }),
      }).catch(() => {});
      setWorkspaceId(payload.data.id);
      setNewName("");
      setNewSlug("");
      setSlugTouched(false);
      setNotice({ kind: "success", text: "Workspace created." });
      router.refresh();
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Could not create the workspace." });
    } finally {
      setCreating(false);
    }
  }

  const slugValid = /^[a-z0-9][a-z0-9-]+[a-z0-9]$/.test(newSlug);

  return (
    <div className="min-h-dvh bg-[#f6f7fb] text-slate-950">
      <div className="flex min-h-dvh">
        <WorkspaceSidebar
          locale={locale}
          workspaces={workspaces}
          activeWorkspaceId={workspaceId}
          activePage="team"
          onWorkspaceChange={setWorkspaceId}
        />

        <main className="mx-auto min-w-0 max-w-5xl flex-1 space-y-6 px-5 py-8 pb-24 sm:px-8 lg:pb-10">
          <header>
            <p className="text-xs font-bold uppercase tracking-[0.15em] text-violet-700">Workspace and team</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">
              {workspace ? workspace.name : "Team"}
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              {workspace?.is_personal
                ? "This is your personal workspace. Create a team workspace below to work with other people."
                : "See who has access, invite people, and manage roles."}
            </p>
          </header>

          {notice && (
            <div
              role={notice.kind === "error" ? "alert" : "status"}
              className={
                notice.kind === "error"
                  ? "flex items-start justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
                  : "flex items-start justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"
              }
            >
              <span>{notice.text}</span>
              <button type="button" className="font-semibold underline" onClick={() => setNotice(null)}>
                Dismiss
              </button>
            </div>
          )}

          {!workspace ? (
            <p className="rounded-2xl border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-600">
              No workspace is available for this account yet. Create one below.
            </p>
          ) : (
            <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6" aria-labelledby="members-heading">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.13em] text-slate-400">
                    <Users className="h-3.5 w-3.5" /> People with access
                  </div>
                  <h2 id="members-heading" className="mt-2 text-lg font-semibold">
                    Members
                  </h2>
                </div>
                <span className="rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs font-semibold text-slate-600">
                  {members.length} of {workspace.seat_limit} seats
                </span>
              </div>

              {loading ? (
                <div className="mt-5 space-y-3" aria-label="Loading members">
                  {Array.from({ length: 2 }).map((_, index) => (
                    <div key={index} className="h-14 animate-pulse rounded-xl bg-slate-100" />
                  ))}
                </div>
              ) : loadError ? (
                <div className="mt-5 rounded-xl bg-slate-50 p-4 text-sm text-slate-600">
                  {loadError}{" "}
                  <button type="button" className="font-semibold text-violet-700 underline" onClick={() => void loadMembers(workspace.id)}>
                    Try again
                  </button>
                </div>
              ) : (
                <ul className="mt-4 divide-y divide-slate-100">
                  {members.map((member) => {
                    const self = member.userId === currentUserId;
                    const busy = busyUser === member.userId;
                    const name = member.fullName?.trim() || (self ? "You" : "Member");
                    const initials = name
                      .split(/\s+/)
                      .map((part) => part[0])
                      .join("")
                      .slice(0, 2)
                      .toUpperCase();
                    const editable = canManage && member.role !== "owner" && !self;
                    return (
                      <li key={member.userId} className="flex flex-wrap items-center gap-3 py-3">
                        <span
                          aria-hidden="true"
                          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-violet-100 text-xs font-bold text-violet-700"
                        >
                          {initials}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5 truncate text-sm font-semibold text-slate-900">
                            {name}
                            {self && <span className="text-xs font-medium text-slate-400">(you)</span>}
                            {member.isVerified && <BadgeCheck className="h-4 w-4 text-sky-500" aria-label="Verified" />}
                          </span>
                          <span className="block text-xs text-slate-500">
                            {ROLE_HELP[member.role]} · joined {joinedLabel(member.createdAt, locale)}
                          </span>
                        </span>

                        {editable ? (
                          <label className="flex items-center gap-2">
                            <span className="sr-only">Role for {name}</span>
                            <select
                              value={member.role}
                              disabled={busy}
                              onChange={(event) => void changeRole(member, event.target.value)}
                              className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-xs font-semibold capitalize text-slate-700 outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-100 disabled:opacity-60"
                            >
                              {ASSIGNABLE_ROLES.map((role) => (
                                <option key={role} value={role}>
                                  {role}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : (
                          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold capitalize text-slate-600">
                            {member.role}
                          </span>
                        )}

                        {(editable || (self && member.role !== "owner")) && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void removeMember(member)}
                            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-600 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-60"
                          >
                            {busy ? (
                              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                            ) : self ? (
                              <UserMinus className="h-3.5 w-3.5" />
                            ) : (
                              <Trash2 className="h-3.5 w-3.5" />
                            )}
                            {self ? "Leave" : "Remove"}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}

          {workspace && !workspace.is_personal && canManage && (
            <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6" aria-labelledby="invite-heading">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.13em] text-slate-400">
                <Mail className="h-3.5 w-3.5" /> Invite
              </div>
              <h2 id="invite-heading" className="mt-2 text-lg font-semibold">
                Invite someone by email
              </h2>
              <form onSubmit={sendInvite} className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_150px_auto]">
                <label className="block">
                  <span className="sr-only">Email address</span>
                  <input
                    type="email"
                    required
                    value={inviteEmail}
                    onChange={(event) => setInviteEmail(event.target.value)}
                    placeholder="name@company.com"
                    maxLength={254}
                    className="h-11 w-full rounded-xl border border-slate-200 px-3 text-sm outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-100"
                  />
                </label>
                <label className="block">
                  <span className="sr-only">Role</span>
                  <select
                    value={inviteRole}
                    onChange={(event) => setInviteRole(event.target.value as (typeof ASSIGNABLE_ROLES)[number])}
                    className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm capitalize outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-100"
                  >
                    {ASSIGNABLE_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="submit"
                  disabled={inviting || !inviteEmail.trim()}
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-violet-600 px-5 text-sm font-semibold text-white transition hover:bg-violet-700 disabled:opacity-60"
                >
                  {inviting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                  Send invite
                </button>
              </form>
              <p className="mt-3 text-xs text-slate-400">{ROLE_HELP[inviteRole]}. Invites expire after 7 days.</p>
            </section>
          )}

          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6" aria-labelledby="create-heading">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.13em] text-slate-400">
              <Plus className="h-3.5 w-3.5" /> New workspace
            </div>
            <h2 id="create-heading" className="mt-2 text-lg font-semibold">
              Create a team workspace
            </h2>
            <form onSubmit={createWorkspace} className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-xs font-medium text-slate-500">Name</span>
                <input
                  required
                  minLength={2}
                  maxLength={80}
                  value={newName}
                  onChange={(event) => {
                    setNewName(event.target.value);
                    if (!slugTouched) setNewSlug(slugify(event.target.value));
                  }}
                  placeholder="Acme Studio"
                  className="mt-1.5 h-11 w-full rounded-xl border border-slate-200 px-3 text-sm outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-100"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-slate-500">Address</span>
                <input
                  required
                  value={newSlug}
                  onChange={(event) => {
                    setSlugTouched(true);
                    setNewSlug(slugify(event.target.value));
                  }}
                  placeholder="acme-studio"
                  aria-invalid={newSlug.length > 0 && !slugValid}
                  className="mt-1.5 h-11 w-full rounded-xl border border-slate-200 px-3 text-sm outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-100"
                />
              </label>
              <div className="sm:col-span-2">
                <button
                  type="submit"
                  disabled={creating || newName.trim().length < 2 || !slugValid}
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-violet-600 px-5 text-sm font-semibold text-white transition hover:bg-violet-700 disabled:opacity-60"
                >
                  {creating ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  Create workspace
                </button>
                <p className="mt-2 text-xs text-slate-400">
                  Use 2 to 40 lowercase letters, numbers, or hyphens for the address. You become the owner.
                </p>
              </div>
            </form>
          </section>
        </main>
      </div>
    </div>
  );
}
