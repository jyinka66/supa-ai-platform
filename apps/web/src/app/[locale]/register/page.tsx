"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useParams } from "next/navigation";

const SUPPORTED_LOCALES = new Set(["en", "ar", "fr", "es", "de", "pt", "zh", "ja", "ko", "hi"]);

export default function RegisterPage() {
  const params = useParams<{ locale?: string }>();
  const localeValue = params.locale ?? "en";
  const locale = SUPPORTED_LOCALES.has(localeValue) ? localeValue : "en";
  const base = `/${locale}`;

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSuccess(null);
    setSubmitting(true);

    try {
      const response = await fetch("/api/v1/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), email: email.trim(), password, locale }),
      });
      const payload: { error?: string; detail?: string; message?: string } = await response
        .json()
        .catch(() => ({}));

      if (!response.ok) {
        if (payload.error === "weak_password") {
          setError(payload.detail ?? "Choose a stronger password and try again.");
        } else if (payload.error === "rate_limited") {
          setError("Too many attempts. Please wait a little and try again.");
        } else {
          setError(payload.detail ?? "We couldn't create your account. Please check your details and try again.");
        }
        return;
      }

      setSuccess(payload.message ?? "Registration request received. Check your inbox for the next step.");
      setPassword("");
    } catch {
      setError("We couldn't reach the server. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-dvh bg-[#f7f8fc] px-5 py-6 text-slate-950 sm:px-8">
      <header className="mx-auto flex max-w-6xl items-center justify-between">
        <Link href={base} className="inline-flex items-center gap-2.5" aria-label="Supa home">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-600 text-sm font-black text-white">s.</span>
          <span className="text-xl font-bold tracking-tight">supa<span className="text-violet-600">.</span></span>
        </Link>
        <p className="text-sm text-slate-600">Already a member? <Link href={`${base}/login`} className="font-semibold text-violet-700 hover:text-violet-800">Sign in</Link></p>
      </header>

      <div className="mx-auto grid max-w-5xl overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-[0_24px_80px_-35px_rgba(15,23,42,0.28)] md:mt-12 md:grid-cols-[0.9fr_1.1fr]">
        <aside className="relative hidden overflow-hidden bg-slate-950 p-10 text-white md:flex md:flex-col md:justify-between lg:p-12">
          <div className="pointer-events-none absolute -right-20 -top-16 h-64 w-64 rounded-full bg-violet-600/35 blur-3xl" />
          <div className="relative">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-violet-300">A better place to begin</p>
            <h1 className="mt-5 text-4xl font-semibold leading-tight tracking-tight">Your next chapter starts with one idea.</h1>
            <p className="mt-5 leading-7 text-slate-300">Create your workspace for AI-assisted work, projects, and everyday business essentials.</p>
          </div>
          <div className="relative mt-14 rounded-2xl border border-white/10 bg-white/5 p-5">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/20 text-lg text-violet-200">✦</span>
              <div><p className="font-semibold">Start small. Build momentum.</p><p className="mt-1 text-sm text-slate-400">Your ideas, connected in one place.</p></div>
            </div>
          </div>
        </aside>

        <section className="p-6 sm:p-9 lg:p-12">
          <div className="mb-8 md:hidden">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-violet-700">Get started with Supa</p>
          </div>
          <div className="max-w-md">
            <p className="hidden text-xs font-bold uppercase tracking-[0.18em] text-violet-700 md:block">Create your account</p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Make yourself at home.</h2>
            <p className="mt-3 text-sm leading-6 text-slate-600">Create your account and set up a workspace around the way you work.</p>

            <form onSubmit={onSubmit} className="mt-8 space-y-5">
              <label className="block">
                <span className="text-sm font-semibold text-slate-800">Name <span className="font-normal text-slate-400">(optional)</span></span>
                <input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" maxLength={100} className="mt-2 block w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-violet-500 focus:ring-4 focus:ring-violet-100" placeholder="Your name" disabled={submitting} />
              </label>
              <label className="block">
                <span className="text-sm font-semibold text-slate-800">Email address</span>
                <input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" maxLength={254} className="mt-2 block w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-violet-500 focus:ring-4 focus:ring-violet-100" placeholder="you@example.com" disabled={submitting} />
              </label>
              <label className="block">
                <span className="text-sm font-semibold text-slate-800">Password</span>
                <input type="password" required value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={12} maxLength={256} className="mt-2 block w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-violet-500 focus:ring-4 focus:ring-violet-100" placeholder="Create a strong password" disabled={submitting} />
                <span className="mt-2 block text-xs leading-5 text-slate-500">Use 12 or more characters, or a memorable four-word passphrase.</span>
              </label>

              {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-700">{error}</p>}
              {success && <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm leading-6 text-emerald-800"><p className="font-semibold">You're on your way.</p><p className="mt-1">{success}</p><p className="mt-2"><Link href={`${base}/login`} className="font-semibold underline underline-offset-2">Continue to sign in</Link></p></div>}

              <button type="submit" disabled={submitting} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-violet-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-violet-600/20 transition hover:bg-violet-700 focus:outline-none focus:ring-4 focus:ring-violet-200 disabled:cursor-not-allowed disabled:opacity-60">
                {submitting ? "Creating your account…" : "Create account"} <span aria-hidden="true">→</span>
              </button>
              <p className="text-center text-xs leading-5 text-slate-500">By continuing, you agree to use your account responsibly and keep your sign-in details secure.</p>
            </form>
          </div>
        </section>
      </div>

      <p className="mx-auto mt-6 max-w-5xl text-center text-xs text-slate-500">Have an account already? <Link href={`${base}/login`} className="font-semibold text-violet-700 hover:text-violet-800">Sign in</Link></p>
    </main>
  );
}
