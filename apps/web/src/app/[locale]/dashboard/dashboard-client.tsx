"use client";

import Image from "next/image";
import { useTranslations } from "next-intl";
import type { WorkspaceWithMembership } from "@/lib/workspaces/queries";

interface DashboardClientProps {
  profile: {
    fullName: string | null;
    avatarPath: string | null;
    language: string;
  };
  workspaces: WorkspaceWithMembership[];
}

export function DashboardClient({ profile, workspaces }: DashboardClientProps) {
  const t = useTranslations("dashboard");

  const initials = (profile.fullName ?? "?")
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <main className="mx-auto max-w-5xl p-6">
      <header className="flex items-center justify-between border-b border-border pb-4">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <div className="flex items-center gap-3">
          {profile.avatarPath ? (
            <Image
              src={profile.avatarPath}
              alt=""
              width={32}
              height={32}
              className="h-8 w-8 rounded-full object-cover"
            />
          ) : (
            <div
              aria-hidden="true"
              className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-xs font-semibold text-white"
            >
              {initials}
            </div>
          )}
          <span className="text-sm font-medium">{profile.fullName}</span>
        </div>
      </header>

      <section className="mt-6">
        <h2 className="mb-3 text-lg font-medium">{t("workspaces")}</h2>
        {workspaces.length === 0 ? (
          <p className="text-sm text-textMuted">{t("noWorkspaces")}</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {workspaces.map((ws) => {
              const role = ws.workspace_members[0]?.role ?? "viewer";
              return (
                <li
                  key={ws.id}
                  className="rounded-md border border-border bg-surface p-4 transition hover:bg-surfaceMuted"
                >
                  <div className="flex items-center justify-between">
                    <h3 className="font-medium">{ws.name}</h3>
                    <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">
                      {role}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-textMuted">
                    {ws.is_personal ? t("personalWorkspace") : `/${ws.slug}`}
                  </p>
                  <p className="mt-2 text-xs text-textMuted">
                    {t("plan")}: {ws.plan}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
