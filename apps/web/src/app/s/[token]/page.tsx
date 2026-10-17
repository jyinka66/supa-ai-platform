"use client";

import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { Spinner } from "@supa/ui/spinner";
import { ErrorState } from "@supa/ui/error-state";

interface ShareData {
  linkId: string;
  itemId: string | null;
  folderId: string | null;
  role: string;
  requiresPassword: boolean;
  item: {
    title: string | null;
    type: string | null;
    content: string | null;
    contentFormat: string | null;
    metadata: Record<string, unknown> | null;
    thumbnailUrl: string | null;
    fileUrl: string | null;
  } | null;
  folder: { id: string; name: string } | null;
  shareInfo: {
    expiresAt: string | null;
    maxViews: number | null;
    viewCount: number;
    role: string;
  };
}

export default function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const searchParams = useSearchParams();
  const [data, setData] = useState<ShareData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [verifying, setVerifying] = useState(false);

  const token = use(params);

  const fetchShare = useCallback(async (pwd?: string) => {
    setLoading(true);
    setError(null);

    try {
      const res = pwd
        ? await fetch(`/api/work/share/${token}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: pwd }),
          })
        : await fetch(`/api/work/share/${token}`);

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `error_${res.status}`);
        setLoading(false);
        return;
      }

      const json = await res.json();
      setData(json.data);
    } catch {
      setError("network_error");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void fetchShare();
  }, [fetchShare]);

  // Send dwell-time beacon on unmount.
  useEffect(() => {
    if (!data?.linkId) return;

    const sendBeacon = () => {
      const payload = JSON.stringify({
        shareLinkId: data.linkId,
        durationMs: Math.round(performance.now()),
      });
      if (navigator.sendBeacon) {
        navigator.sendBeacon("/api/work/share/beacon", payload);
      } else {
        void fetch("/api/work/share/beacon", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          keepalive: true,
        }).catch(() => {});
      }
    };

    window.addEventListener("beforeunload", sendBeacon);
    return () => {
      sendBeacon();
      window.removeEventListener("beforeunload", sendBeacon);
    };
  }, [data?.linkId]);

  if (loading) {
    return (
      <main className="flex min-h-dvh items-center justify-center">
        <Spinner size="lg" />
      </main>
    );
  }

  if (error) {
    const messages: Record<string, string> = {
      link_invalid: "This share link is invalid, expired, or has been revoked.",
      wrong_password: "Incorrect password. Please try again.",
      network_error: "Network error. Please check your connection.",
    };
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <ErrorState
          title="Cannot access shared content"
          description={messages[error] ?? error}
          onRetry={() => void fetchShare()}
        />
      </main>
    );
  }

  if (!data) return null;

  // Password required screen.
  if (data.requiresPassword) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setVerifying(true);
            void fetchShare(password).finally(() => setVerifying(false));
          }}
          className="w-full max-w-sm space-y-4"
        >
          <h1 className="text-xl font-semibold">Password required</h1>
          <p className="text-sm text-textMuted">
            This shared content is protected. Enter the password to view it.
          </p>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter password"
            className="block w-full rounded-md border border-border bg-surface px-3 py-2 text-text"
            autoFocus
            required
          />
          <button
            type="submit"
            disabled={verifying || !password}
            className="w-full rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-accentHover disabled:opacity-50"
          >
            {verifying ? "Verifying..." : "View content"}
          </button>
        </form>
      </main>
    );
  }

  // Content display.
  const item = data.item;
  const folder = data.folder;

  return (
    <main className="mx-auto max-w-4xl p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">
          {item?.title ?? folder?.name ?? "Shared content"}
        </h1>
        {item?.type && (
          <p className="mt-1 text-sm text-textMuted capitalize">{item.type.replace(/_/g, " ")}</p>
        )}
        {data.shareInfo.expiresAt && (
          <p className="mt-1 text-xs text-textMuted">
            Expires {new Date(data.shareInfo.expiresAt).toLocaleDateString()}
          </p>
        )}
      </header>

      {/* Content */}
      {item?.thumbnailUrl && (
        <img
          src={item.thumbnailUrl}
          alt={item.title ?? ""}
          className="mb-6 max-h-96 w-full rounded-md object-contain"
        />
      )}

      {item?.content && (
        <div className="prose prose-sm max-w-none whitespace-pre-wrap break-words rounded-md border border-border bg-surface p-6">
          {item.content}
        </div>
      )}

      {item?.fileUrl && !item.content && (
        <a
          href={item.fileUrl}
          download
          className="inline-block rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-accentHover"
        >
          Download file
        </a>
      )}

      {folder && (
        <div className="rounded-md border border-border bg-surfaceMuted p-4 text-sm text-textMuted">
          Shared folder: {folder.name}
        </div>
      )}

      <footer className="mt-8 border-t border-border pt-4 text-xs text-textMuted">
        View count: {data.shareInfo.viewCount}
        {data.shareInfo.maxViews && ` / ${data.shareInfo.maxViews}`}
      </footer>
    </main>
  );
}

// React 19 `use()` hook for unwrapping promises.
import { use } from "react";
