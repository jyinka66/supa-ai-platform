"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { supabaseBrowser } from "@/lib/supabase/client";

export default function MfaChallengePage() {
  const router = useRouter();
  const params = useSearchParams();
  const t = useTranslations("auth.challenge");
  const next = params.get("next") ?? "/dashboard";

  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { data, error: verifyError } = await supabaseBrowser.auth.mfa.verify({
      factorId: params.get("factorId") ?? "",
      challengeId: params.get("challengeId") ?? "",
      code: code.trim(),
    });

    if (verifyError || !data) {
      setError(verifyError?.message ?? "Verification failed");
      setLoading(false);
      return;
    }

    // Refresh the AAL cookie by hitting the auth refresh route.
    await fetch("/api/auth/refresh-aal", { method: "POST" });
    router.push(next);
    router.refresh();
  }

  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>

        <label className="block">
          <span className="text-sm font-medium text-text">{t("code")}</span>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            autoComplete="one-time-code"
            required
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            className="mt-1 block w-full rounded-md border border-border bg-surface px-3 py-2 text-lg tracking-[0.5em] text-text"
            disabled={loading}
          />
        </label>

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={loading || code.length !== 6}
            className="flex-1 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-accentHover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("verify")}
          </button>
          <button
            type="button"
            onClick={() => router.back()}
            className="rounded-md border border-border px-4 py-2 text-sm font-medium text-text transition hover:bg-surfaceMuted"
          >
            {t("cancel")}
          </button>
        </div>
      </form>
    </main>
  );
}
