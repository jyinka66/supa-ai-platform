"use client";

import { useState, useEffect, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";

/**
 * Invite acceptance page — shown when a user clicks the link in the invite email.
 *
 * URL: /<locale>/invite/accept?token=<rawToken>
 *
 * Flow:
 *   1. If the user is already signed in AND the token matches their email,
 *      auto-accept via POST /api/invites/accept
 *   2. If not signed in, show a "sign in to accept" CTA → /<locale>/login?next=/<locale>/invite/accept?token=...
 *   3. If the token is invalid/expired, show an error message
 */
export default function InviteAcceptPage() {
  const router = useRouter();
  const params = useSearchParams();
  const t = useTranslations("invite");

  const token = params.get("token");
  const [status, setStatus] = useState<"idle" | "accepting" | "accepted" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setError("missing_token");
      setStatus("error");
      return;
    }

    // Try to accept the invite — the API will return 401 if not authenticated.
    async function tryAccept() {
      setStatus("accepting");
      try {
        const res = await fetch("/api/invites/accept", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });

        if (res.status === 401) {
          // Not signed in — redirect to login with a return URL.
          const locale = window.location.pathname.split("/")[1] ?? "en";
          router.push(`/${locale}/login?next=/${locale}/invite/accept?token=${encodeURIComponent(token!)}`);
          return;
        }

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.error ?? "invite_invalid");
          setStatus("error");
          return;
        }

        const data = await res.json();
        setStatus("accepted");
        // Redirect to the workspace dashboard after a short delay.
        setTimeout(() => {
          router.push(`/en/dashboard?workspace=${data?.data?.workspaceId ?? ""}`);
        }, 1500);
      } catch {
        setError("network_error");
        setStatus("error");
      }
    }

    void tryAccept();
  }, [token, router]);

  if (!token) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <div className="max-w-md text-center">
          <h1 className="text-xl font-semibold">{t("invalidTitle")}</h1>
          <p className="mt-2 text-sm text-textMuted">{t("missingToken")}</p>
        </div>
      </main>
    );
  }

  if (status === "accepting") {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <div className="max-w-md text-center">
          <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <p className="text-sm text-textMuted">{t("accepting")}</p>
        </div>
      </main>
    );
  }

  if (status === "accepted") {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <div className="max-w-md text-center">
          <h1 className="text-xl font-semibold text-success">{t("acceptedTitle")}</h1>
          <p className="mt-2 text-sm text-textMuted">{t("acceptedBody")}</p>
        </div>
      </main>
    );
  }

  if (status === "error") {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <div className="max-w-md text-center">
          <h1 className="text-xl font-semibold text-danger">{t("invalidTitle")}</h1>
          <p className="mt-2 text-sm text-textMuted">
            {error === "invite_invalid" && t("invalidOrExpired")}
            {error === "invite_consumed" && t("alreadyConsumed")}
            {error === "invite_email_mismatch" && t("emailMismatch")}
            {error === "missing_token" && t("missingToken")}
            {error === "network_error" && t("networkError")}
            {!error && t("invalidOrExpired")}
          </p>
        </div>
      </main>
    );
  }

  return null;
}
