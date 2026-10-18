"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { supabaseBrowser } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const params = useSearchParams();
  const pathname = usePathname();
  const pathLocale = pathname.split("/")[1] ?? "en";
  const locale = ["en", "ar", "fr", "es", "de", "pt", "zh", "ja", "ko", "hi"].includes(pathLocale) ? pathLocale : "en";
  const base = `/${locale}`;
  const t = useTranslations("auth.login");
  const requestedNext = params.get("next");
  const next = requestedNext?.startsWith("/") && !requestedNext.startsWith("//")
    ? requestedNext
    : `${base}/dashboard`;
  const errorCode = params.get("error");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(
    errorCode ? `errors.${errorCode}` : null,
  );

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { error: signInError } = await supabaseBrowser.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (signInError) {
      setError(signInError.message);
      setLoading(false);
      return;
    }

    await fetch("/api/auth/refresh-aal", { method: "POST" });
    router.push(next);
    router.refresh();
  }

  return (
    <main className="min-h-dvh bg-[#f7f8fc] px-5 py-6 text-slate-950 sm:px-8">
      <header className="mx-auto flex max-w-6xl items-center justify-between">
        <Link href={base} className="inline-flex items-center gap-2.5" aria-label="Supa home">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-600 text-sm font-black text-white">s.</span>
          <span className="text-xl font-bold tracking-tight">supa<span className="text-violet-600">.</span></span>
        </Link>
        <p className="text-sm text-slate-600">New to Supa? <Link href={`${base}/register`} className="font-semibold text-violet-700 hover:text-violet-800">Create an account</Link></p>
      </header>

      <div className="mx-auto mt-10 grid max-w-5xl overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-[0_24px_80px_-35px_rgba(15,23,42,0.28)] md:mt-16 md:grid-cols-[0.9fr_1.1fr]">
        <aside className="relative hidden overflow-hidden bg-slate-950 p-10 text-white md:flex md:flex-col md:justify-between lg:p-12">
          <div className="pointer-events-none absolute -right-20 -top-16 h-64 w-64 rounded-full bg-violet-600/35 blur-3xl" />
          <div className="relative">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-violet-300">Welcome back</p>
            <h1 className="mt-5 text-4xl font-semibold leading-tight tracking-tight">Pick up where your best work left off.</h1>
            <p className="mt-5 leading-7 text-slate-300">Your ideas, projects, and everyday work are waiting in one connected space.</p>
          </div>
          <div className="relative rounded-2xl border border-white/10 bg-white/5 p-5">
            <p className="text-sm font-semibold">Good work starts with a clear next step.</p>
            <p className="mt-2 text-sm leading-6 text-slate-400">Sign in to continue to your workspace.</p>
          </div>
        </aside>

        <section className="p-6 sm:p-9 lg:p-12">
          <div className="mx-auto max-w-md">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-violet-700">Your workspace awaits</p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">{t("title")}</h2>
            <p className="mt-3 text-sm leading-6 text-slate-600">Sign in to get back to your work.</p>

            <form onSubmit={onSubmit} className="mt-8 space-y-5">
              <label className="block">
                <span className="text-sm font-semibold text-slate-800">{t("email")}</span>
                <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} className="mt-2 block w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-slate-950 outline-none transition focus:border-violet-500 focus:ring-4 focus:ring-violet-100" disabled={loading} />
              </label>
              <label className="block">
                <span className="text-sm font-semibold text-slate-800">{t("password")}</span>
                <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="mt-2 block w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-slate-950 outline-none transition focus:border-violet-500 focus:ring-4 focus:ring-violet-100" disabled={loading} />
              </label>
              {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-700">{error}</p>}
              <button type="submit" disabled={loading} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-violet-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-violet-600/20 transition hover:bg-violet-700 focus:outline-none focus:ring-4 focus:ring-violet-200 disabled:cursor-not-allowed disabled:opacity-60">
                {loading ? "Signing in…" : t("submit")} <span aria-hidden="true">→</span>
              </button>
              <p className="text-center text-sm text-slate-600">New to Supa? <Link href={`${base}/register`} className="font-semibold text-violet-700 hover:text-violet-800">Create an account</Link></p>
            </form>
          </div>
        </section>
      </div>
    </main>
  );
}
