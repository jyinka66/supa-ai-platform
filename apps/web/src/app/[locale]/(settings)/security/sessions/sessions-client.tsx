"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { ErrorState } from "@supa/ui/error-state";
import { Spinner } from "@supa/ui/spinner";

interface SessionRow {
  id: string;
  userAgent: string | null;
  ipMasked: string | null;
  createdAt: string;
  lastActiveAt: string;
  revokedAt: string | null;
}

interface SessionsClientProps {
  sessions: SessionRow[];
  currentSessionId: string | null;
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function parseDevice(ua: string | null): { device: string; browser: string; os: string } {
  if (!ua) return { device: "Unknown device", browser: "", os: "" };
  const browser =
    /edg/i.test(ua) ? "Edge" :
    /chrome/i.test(ua) ? "Chrome" :
    /firefox/i.test(ua) ? "Firefox" :
    /safari/i.test(ua) ? "Safari" : "Unknown browser";
  const os =
    /windows/i.test(ua) ? "Windows" :
    /mac os/i.test(ua) ? "macOS" :
    /linux/i.test(ua) ? "Linux" :
    /android/i.test(ua) ? "Android" :
    /iphone|ipad/i.test(ua) ? "iOS" : "Unknown OS";
  return { device: `${browser} on ${os}`, browser, os };
}

export function SessionsClient({ sessions, currentSessionId }: SessionsClientProps) {
  const t = useTranslations("settings.sessions");
  const [rows, setRows] = useState(sessions);
  const [error, setError] = useState<string | null>(null);
  const [confirmingRevokeAll, setConfirmingRevokeAll] = useState(false);
  const [pending, startTransition] = useTransition();

  function revokeOne(id: string) {
    if (!confirm("Revoke this session? The device will be signed out.")) return;
    setError(null);

    // Optimistic update.
    setRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, revokedAt: new Date().toISOString() } : r)),
    );

    startTransition(async () => {
      const res = await fetch(`/api/sessions/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "revoke_failed");
        // Rollback optimistic update.
        setRows(sessions);
      }
    });
  }

  function revokeAll() {
    if (!confirm("Revoke ALL sessions? You will be signed out everywhere.")) return;
    setError(null);
    setConfirmingRevokeAll(false);

    startTransition(async () => {
      const res = await fetch("/api/sessions", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revoke_all: true }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "revoke_failed");
        return;
      }
      // The /api/sessions DELETE response triggers a global sign-out.
      // The browser session cookie is invalidated; reload to land on the login page.
      window.location.href = "/login";
    });
  }

  const active = rows.filter((r) => !r.revokedAt);
  const revoked = rows.filter((r) => r.revokedAt);

  if (pending && rows.length === 0) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }

  if (error && rows.length === 0) {
    return <ErrorState onRetry={() => window.location.reload()} />;
  }

  return (
    <section className="space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <button
          type="button"
          disabled={active.length <= 1}
          onClick={() => setConfirmingRevokeAll(true)}
          className="rounded-md border border-danger/30 bg-danger/5 px-3 py-1.5 text-sm font-medium text-danger transition hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("revokeAll")}
        </button>
      </header>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <div className="space-y-2">
        <h2 className="text-sm font-medium text-textMuted">{t("active")}</h2>
        {active.length === 0 ? (
          <p className="rounded-md border border-border bg-surfaceMuted p-4 text-sm text-textMuted">
            {t("noOtherDevices")}
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {active.map((row) => {
              const { device } = parseDevice(row.userAgent);
              const isCurrent = row.id === currentSessionId;
              return (
                <li
                  key={row.id}
                  className="flex items-center justify-between gap-3 p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      {device}
                      {isCurrent && (
                        <span className="rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success">
                          {t("current")}
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 text-xs text-textMuted">
                      {t("lastActive")} {formatRelative(row.lastActiveAt)}
                      {row.ipMasked && ` · ${row.ipMasked}`}
                    </p>
                  </div>
                  {!isCurrent && (
                    <button
                      type="button"
                      onClick={() => revokeOne(row.id)}
                      disabled={pending}
                      className="rounded-md border border-border px-3 py-1 text-xs font-medium text-textMuted transition hover:bg-surfaceMuted hover:text-text"
                    >
                      {t("revoke")}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {revoked.length > 0 && (
        <details className="rounded-md border border-border bg-surface">
          <summary className="cursor-pointer p-3 text-sm font-medium text-textMuted">
            {t("revoked")} ({revoked.length})
          </summary>
          <ul className="divide-y divide-border border-t border-border">
            {revoked.map((row) => (
              <li key={row.id} className="p-3 text-sm text-textMuted">
                {parseDevice(row.userAgent).device} · revoked {formatRelative(row.revokedAt!)}
              </li>
            ))}
          </ul>
        </details>
      )}

      {confirmingRevokeAll && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
          <div className="w-full max-w-sm rounded-md border border-border bg-surface p-6">
            <h3 className="text-lg font-semibold">{t("confirmRevokeAllTitle")}</h3>
            <p className="mt-2 text-sm text-textMuted">{t("confirmRevokeAllBody")}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmingRevokeAll(false)}
                className="rounded-md border border-border px-3 py-1.5 text-sm font-medium"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={revokeAll}
                disabled={pending}
                className="rounded-md bg-danger px-3 py-1.5 text-sm font-medium text-white transition hover:bg-danger/90 disabled:opacity-50"
              >
                {pending ? "Revoking…" : t("revokeAll")}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
