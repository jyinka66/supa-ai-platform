import Link from "next/link";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { isLocale } from "@/lib/i18n/config";

type Props = {
  params: Promise<{ locale: string }>;
};

function Wordmark({ inverse = false }: { inverse?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className={`flex h-9 w-9 items-center justify-center rounded-xl text-sm font-black text-white shadow-sm ${inverse ? "bg-white/15 ring-1 ring-white/20" : "bg-violet-600"}`}>
        s.
      </span>
      <span className={`text-xl font-bold tracking-tight ${inverse ? "text-white" : "text-slate-950"}`}>supa<span className={inverse ? "text-violet-300" : "text-violet-600"}>.</span></span>
    </span>
  );
}

function FeatureCard({ icon, title, children }: { icon: string; title: string; children: ReactNode }) {
  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition duration-200 hover:-translate-y-1 hover:shadow-lg">
      <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-xl bg-violet-50 text-lg text-violet-700 ring-1 ring-violet-100">{icon}</div>
      <h3 className="text-lg font-semibold tracking-tight text-slate-950">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-slate-600">{children}</p>
    </article>
  );
}

export default async function LandingPage({ params }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const base = `/${locale}`;

  return (
    <main className="min-h-dvh overflow-hidden bg-[#f7f8fc] text-slate-950">
      <header className="relative z-10 mx-auto flex w-full max-w-7xl items-center justify-between px-5 py-5 sm:px-8 lg:px-10">
        <Link href={base} aria-label="Supa home"><Wordmark /></Link>
        <nav className="hidden items-center gap-8 text-sm font-medium text-slate-600 md:flex" aria-label="Main navigation">
          <a href="#workspace" className="transition hover:text-violet-700">The workspace</a>
          <a href="#features" className="transition hover:text-violet-700">What you can do</a>
        </nav>
        <div className="flex items-center gap-3">
          <Link href={`${base}/login`} className="rounded-xl px-3 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 sm:px-4">Sign in</Link>
          <Link href={`${base}/register`} className="rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-violet-600/20 transition hover:bg-violet-700 focus:outline-none focus:ring-4 focus:ring-violet-200 sm:px-5">Get started <span aria-hidden="true">↗</span></Link>
        </div>
      </header>

      <section id="workspace" className="relative mx-auto grid w-full max-w-7xl items-center gap-12 px-5 pb-20 pt-12 sm:px-8 sm:pt-16 lg:grid-cols-[1.02fr_0.98fr] lg:gap-16 lg:px-10 lg:pb-28 lg:pt-20">
        <div className="pointer-events-none absolute -left-48 top-5 h-96 w-96 rounded-full bg-violet-200/45 blur-3xl" />
        <div className="relative z-10 max-w-2xl">
          <div className="inline-flex items-center gap-2 rounded-full border border-violet-200 bg-white/80 px-3.5 py-2 text-xs font-semibold tracking-wide text-violet-800 shadow-sm">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            ONE CONNECTED AI WORKSPACE
          </div>
          <h1 className="mt-7 text-5xl font-semibold leading-[1.04] tracking-[-0.055em] text-slate-950 sm:text-6xl lg:text-[4.5rem]">
            Less busywork.
            <span className="mt-1 block text-violet-600">More brilliant work.</span>
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-8 text-slate-600 sm:text-xl sm:leading-8">
            Bring your ideas, conversations, projects and everyday business workflows into one calm, connected workspace.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link href={`${base}/register`} className="inline-flex min-h-14 items-center justify-center gap-3 rounded-xl bg-violet-600 px-6 py-3.5 text-base font-semibold text-white shadow-xl shadow-violet-600/20 transition hover:-translate-y-0.5 hover:bg-violet-700 focus:outline-none focus:ring-4 focus:ring-violet-200">
              Create your workspace <span aria-hidden="true">→</span>
            </Link>
            <Link href={`${base}/login`} className="inline-flex min-h-14 items-center justify-center rounded-xl border border-slate-200 bg-white px-6 py-3.5 text-base font-semibold text-slate-700 shadow-sm transition hover:border-slate-300 hover:bg-slate-50">
              I already have an account
            </Link>
          </div>
          <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-slate-500">
            <span className="inline-flex items-center gap-2"><span className="text-emerald-600">✓</span> A workspace built around you</span>
            <span className="inline-flex items-center gap-2"><span className="text-emerald-600">✓</span> Your work, in one place</span>
          </div>
        </div>

        <div className="relative mx-auto w-full max-w-xl lg:ml-auto">
          <div className="absolute -right-10 -top-12 h-48 w-48 rounded-full bg-fuchsia-200/70 blur-3xl" />
          <div className="absolute -bottom-10 -left-8 h-48 w-48 rounded-full bg-sky-200/60 blur-3xl" />
          <div className="relative rounded-[1.8rem] border border-white/80 bg-white/90 p-3 shadow-[0_30px_90px_-30px_rgba(49,46,129,0.28)] ring-1 ring-slate-200/80 sm:p-4">
            <div className="rounded-[1.25rem] border border-slate-100 bg-white p-5 sm:p-6">
              <div className="flex items-center justify-between gap-4 border-b border-slate-100 pb-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-600 text-sm font-bold text-white">s.</div>
                  <div><p className="text-sm font-semibold text-slate-900">Your workspace</p><p className="mt-0.5 text-xs text-slate-500">A little more clarity, every day</p></div>
                </div>
                <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">All in one place</span>
              </div>
              <div className="py-6">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">Start with an idea</p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">What are we working on?</h2>
                <p className="mt-2 text-sm leading-6 text-slate-500">Ask for a first draft, organize a plan, or pick up where you left off.</p>
                <div className="mt-5 flex items-center gap-3 rounded-2xl border border-violet-100 bg-violet-50/70 p-3.5">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-violet-700 shadow-sm">✦</div>
                  <div className="min-w-0 flex-1"><p className="text-sm font-medium text-slate-800">Help me plan my next project</p><p className="mt-1 text-xs text-slate-500">Turn a thought into a next step</p></div>
                  <span className="text-lg text-violet-700" aria-hidden="true">↗</span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4"><div className="flex items-center gap-2 text-xs font-medium text-slate-500"><span className="h-2 w-2 rounded-full bg-sky-500" /> Projects</div><p className="mt-3 text-sm font-semibold text-slate-900">From idea to done</p><p className="mt-1 text-xs leading-5 text-slate-500">Keep next steps close</p></div>
                <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4"><div className="flex items-center gap-2 text-xs font-medium text-slate-500"><span className="h-2 w-2 rounded-full bg-amber-500" /> Business</div><p className="mt-3 text-sm font-semibold text-slate-900">Know where things stand</p><p className="mt-1 text-xs leading-5 text-slate-500">Invoices, expenses and more</p></div>
              </div>
              <p className="mt-4 text-center text-[11px] text-slate-400">Illustrative preview · Your workspace starts with you</p>
            </div>
          </div>
        </div>
      </section>

      <section id="features" className="border-y border-slate-200/80 bg-white py-20 sm:py-24">
        <div className="mx-auto max-w-7xl px-5 sm:px-8 lg:px-10">
          <div className="mx-auto max-w-2xl text-center">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-violet-700">Made for the way work really happens</p>
            <h2 className="mt-4 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">Everything works better when it connects.</h2>
            <p className="mt-4 text-base leading-7 text-slate-600">Less switching between tools. More time to think, create, and move your work forward.</p>
          </div>
          <div className="mt-12 grid gap-5 md:grid-cols-3">
            <FeatureCard icon="✦" title="AI that helps you move">Explore ideas, draft content, summarize information, and turn a blank page into a practical next step.</FeatureCard>
            <FeatureCard icon="▦" title="One connected workspace">Keep your projects and team work together, with clear spaces for the things you are building.</FeatureCard>
            <FeatureCard icon="↗" title="Business essentials at hand">Bring everyday workflows like invoices, expenses, and reports closer to the rest of your work.</FeatureCard>
          </div>
        </div>
      </section>

      <section className="px-5 py-20 sm:px-8 sm:py-24 lg:px-10">
        <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-7 overflow-hidden rounded-[2rem] bg-slate-950 px-7 py-10 text-white sm:px-10 sm:py-12 lg:flex-row lg:items-center lg:px-14">
          <div className="relative z-10 max-w-2xl">
            <Wordmark inverse />
            <h2 className="mt-6 text-3xl font-semibold tracking-tight sm:text-4xl">Make space for your next big thing.</h2>
            <p className="mt-3 max-w-xl leading-7 text-slate-300">Start with one idea. Build a workspace that grows with your work.</p>
          </div>
          <Link href={`${base}/register`} className="relative z-10 inline-flex shrink-0 items-center justify-center gap-3 rounded-xl bg-white px-6 py-4 text-sm font-bold text-slate-950 transition hover:bg-violet-100">Get started <span aria-hidden="true">→</span></Link>
          <div className="pointer-events-none absolute" />
        </div>
      </section>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-5 py-6 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-10">
          <Link href={base} aria-label="Supa home"><Wordmark /></Link>
          <p>Make good work happen.</p>
          <div className="flex gap-5"><Link href={`${base}/login`} className="hover:text-violet-700">Sign in</Link><Link href={`${base}/register`} className="font-semibold text-violet-700 hover:text-violet-800">Create account</Link></div>
        </div>
      </footer>
    </main>
  );
}
