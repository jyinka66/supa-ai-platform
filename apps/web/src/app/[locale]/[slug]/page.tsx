import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/lib/i18n/config";

type Props = { params: Promise<{ locale: string; slug: string }> };
type Section = { heading: string; paragraphs: string[]; bullets?: string[] };
type PageContent = { eyebrow: string; title: string; intro: string; sections: Section[] };

const PAGES: Record<string, PageContent> = {
  about: {
    eyebrow: "About Supa",
    title: "Make room for your best work.",
    intro: "Supa is being built as a connected workspace for ideas, AI-assisted work, projects, and everyday business tasks.",
    sections: [
      { heading: "Why we are building it", paragraphs: ["Work can become scattered across conversations, documents, tools, and to-do lists. Supa aims to bring those pieces closer together so it is easier to think clearly and move from an idea to a next step."] },
      { heading: "What matters to us", paragraphs: ["Useful tools should feel clear, approachable, and respectful of the people who use them. We are working toward a workspace that helps individuals and teams spend less time on busywork and more time making progress."] },
      { heading: "A product in progress", paragraphs: ["Supa is actively evolving. Available features and integrations may change as the product develops; we will use the product updates page to share changes as they are published."] }
    ]
  },
  privacy: {
    eyebrow: "Legal",
    title: "Privacy policy",
    intro: "This notice explains, in plain language, the types of information Supa may process to provide and protect the service. Last updated: 18 October 2026.",
    sections: [
      { heading: "Information you provide", paragraphs: ["Depending on the features you use, this may include account details such as your email address and name, profile preferences, prompts, files, messages, and information you choose to store in a workspace. Do not submit passwords, payment-card details, secrets, or other sensitive information into general prompts unless a feature specifically asks for it."] },
      { heading: "Technical and usage information", paragraphs: ["The service may process basic request, device, diagnostic, security, and usage information to keep accounts working, prevent abuse, diagnose problems, and improve reliability. The exact information collected depends on the features and integrations enabled for the deployment you use."] },
      { heading: "How information is used", paragraphs: ["Information is used to authenticate you, provide requested features, save your settings and workspace data, secure the service, troubleshoot errors, respond to support requests, and meet applicable legal obligations."] },
      { heading: "Service providers", paragraphs: ["Supa uses hosting and authentication/database infrastructure, including Vercel and Supabase for the current application architecture. Analytics and error-monitoring providers may process limited technical or usage data when those integrations are enabled. Providers process information under their own terms and configuration."] },
      { heading: "Sharing, retention, and security", paragraphs: ["We do not sell personal information as a product. Information may be processed by service providers, disclosed when legally required, or handled to protect users and the service. Retention depends on the data type, product configuration, and legal requirements. Technical safeguards are used, but no online service can guarantee absolute security."] },
      { heading: "Your choices and privacy requests", paragraphs: ["Keep your account details current and only add information you are comfortable storing in the service. For a privacy question or a request to access, correct, or delete information, use the contact options shown on the Contact page. If no support address is displayed there, a dedicated contact channel has not yet been published for this deployment."] }
    ]
  },
  terms: {
    eyebrow: "Legal",
    title: "Terms of use",
    intro: "These terms describe the basic rules for using Supa. Last updated: 18 October 2026.",
    sections: [
      { heading: "Your account", paragraphs: ["Provide accurate account information, keep your sign-in details secure, and tell us promptly if you believe someone has accessed your account without permission. You are responsible for activity carried out through your account, subject to applicable law."] },
      { heading: "Acceptable use", paragraphs: ["Do not use Supa to break the law, violate another person's rights, interfere with the service, bypass security controls, distribute malicious code, or attempt to access other users' information without authorization. Do not upload content you lack the right to use."] },
      { heading: "Your content and AI results", paragraphs: ["You remain responsible for the content you submit and how you use the results returned by AI-powered features. AI output can be incomplete, inaccurate, or unsuitable for a particular purpose; review important results before relying on them. You should not treat AI output as professional, legal, medical, or financial advice."] },
      { heading: "Service changes and availability", paragraphs: ["Features may change as the product develops, and the service may occasionally be unavailable for maintenance, security, or technical reasons. We will not represent a feature as available unless it is offered in the version you use. Any prices or paid terms will be presented before you are asked to purchase a paid offering."] },
      { heading: "Enforcement and questions", paragraphs: ["We may restrict activity that threatens users, security, or service integrity, subject to applicable law. If you have a question about these terms, visit the Contact page for the current contact options. These terms are a general product notice and should be reviewed by qualified counsel before being relied on as a complete legal agreement."] }
    ]
  },
  contact: {
    eyebrow: "Contact",
    title: "We would like to hear from you.",
    intro: "Use the options below for account access or product questions. Please never send us your password, API keys, recovery codes, or other secrets.",
    sections: [
      { heading: "Account help", paragraphs: ["Having trouble signing in? Start with the sign-in page. If you are new to Supa, you can create an account from the registration page."] },
      { heading: "Support and privacy requests", paragraphs: ["A dedicated support inbox is only shown here when one has been configured for this deployment. Until then, use any support channel included in the product communications you received. For privacy requests, include only the details needed to identify the request—never include your password."] }
    ]
  },
  blog: {
    eyebrow: "From Supa",
    title: "Ideas, guides, and product stories.",
    intro: "The Supa blog is where we plan to share practical ways to work with AI, make projects easier to manage, and get more value from a connected workspace.",
    sections: [
      { heading: "Stories are on the way", paragraphs: ["There are no published posts here yet. When articles are ready, they will appear on this page. In the meantime, explore the product overview or create an account to get started."] }
    ]
  },
  careers: {
    eyebrow: "Careers",
    title: "Help shape what comes next.",
    intro: "We are building toward a more connected way to work, and we want this page to be the home for future opportunities.",
    sections: [
      { heading: "Open roles", paragraphs: ["No roles are currently published on this page. When opportunities are available, this page will include the role details and application instructions."] },
      { heading: "Stay connected", paragraphs: ["You can explore the product today or check back here for future updates. Please do not send confidential personal information through public channels."] }
    ]
  },
  pricing: {
    eyebrow: "Plans",
    title: "Clear pricing, before you commit.",
    intro: "We will publish plan details here before asking customers to purchase a paid offering.",
    sections: [
      { heading: "Pricing is not published yet", paragraphs: ["Supa's available features and plans are still evolving. No price, subscription, or paid commitment is implied by this page. Check back for confirmed plan details."] }
    ]
  },
  help: {
    eyebrow: "Help center",
    title: "Let us help you get unstuck.",
    intro: "A few quick steps for the most common account questions.",
    sections: [
      { heading: "I cannot sign in", paragraphs: ["Check that you are using the email address connected to your account and that your password is entered correctly. If you have not confirmed your email address, check for the verification message first."] },
      { heading: "I just registered", paragraphs: ["Registration may require email confirmation before you can continue. Open the verification link from the same inbox where you registered. It should return you to Supa to finish onboarding."] },
      { heading: "Still need help?", paragraphs: ["Open the Contact page to see the currently available support options. Never share your password, API keys, or verification codes in a support request."] }
    ]
  },
  changelog: {
    eyebrow: "Product updates",
    title: "What is new with Supa.",
    intro: "This page will collect meaningful product releases, improvements, and fixes.",
    sections: [
      { heading: "Updates will appear here", paragraphs: ["There are no public release notes posted yet. Once updates are ready to share, we will list them here with dates and short explanations."] }
    ]
  },
  trust: {
    eyebrow: "Trust & security",
    title: "Security deserves attention at every step.",
    intro: "Supa is designed with security controls around account access, application requests, and the information users choose to store.",
    sections: [
      { heading: "Account protection", paragraphs: ["Use a unique password, keep your email account secure, and never share sign-in links or verification codes. Available authentication controls depend on the account and deployment configuration."] },
      { heading: "Application safeguards", paragraphs: ["The application includes request validation and browser security headers. Like any online service, it may still contain defects; avoid sharing secrets or data you do not have permission to submit."] },
      { heading: "Report a concern", paragraphs: ["For a suspected security issue, use the contact options shown on the Contact page if available. Share only the information needed to describe the issue and never post live credentials, tokens, or personal user data publicly."] }
    ]
  },
  accessibility: {
    eyebrow: "Accessibility",
    title: "Work should be more accessible to everyone.",
    intro: "We want Supa to be clear and usable across devices, input methods, and different needs.",
    sections: [
      { heading: "Our approach", paragraphs: ["We aim to use readable layouts, semantic controls, visible focus states, and responsive design. Not every page or workflow has been independently audited, so we do not claim full conformance to an accessibility standard at this time."] },
      { heading: "Tell us what could be better", paragraphs: ["If you encounter a barrier, visit the Contact page to see the current contact options. Please include the page and task affected, but do not send passwords or private workspace content."] }
    ]
  }
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const page = PAGES[slug];
  return page
    ? { title: page.title + " | Supa", description: page.intro }
    : { title: "Page not found | Supa" };
}

export default async function PublicInfoPage({ params }: Props) {
  const { locale, slug } = await params;
  const page = PAGES[slug];
  if (!isLocale(locale) || !page) notFound();
  const base = "/" + locale;
  const supportEmail = slug === "contact" ? process.env.NEXT_PUBLIC_SUPPORT_EMAIL : undefined;

  return (
    <main className="min-h-dvh bg-[#f7f8fc] text-slate-950">
      <header className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-5 sm:px-8 lg:px-10">
        <Link href={base} className="inline-flex items-center gap-2.5" aria-label="Supa home">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-600 text-sm font-black text-white">s.</span>
          <span className="text-xl font-bold tracking-tight">supa<span className="text-violet-600">.</span></span>
        </Link>
        <nav className="flex items-center gap-3 text-sm sm:gap-5" aria-label="Account navigation">
          <Link href={base + "/login"} className="font-medium text-slate-600 hover:text-violet-700">Sign in</Link>
          <Link href={base + "/register"} className="rounded-xl bg-violet-600 px-4 py-2.5 font-semibold text-white hover:bg-violet-700">Get started</Link>
        </nav>
      </header>

      <div className="mx-auto max-w-4xl px-5 pb-16 pt-10 sm:px-8 sm:pb-24 sm:pt-16">
        <Link href={base} className="text-sm font-semibold text-violet-700 hover:text-violet-800">← Back to Supa</Link>
        <div className="mt-8 rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm sm:p-10 lg:p-12">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-violet-700">{page.eyebrow}</p>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight sm:text-5xl">{page.title}</h1>
          <p className="mt-5 max-w-3xl text-base leading-7 text-slate-600 sm:text-lg">{page.intro}</p>
          {slug === "contact" && supportEmail && (
            <div className="mt-6 rounded-2xl border border-violet-100 bg-violet-50 p-5">
              <p className="text-sm font-semibold text-slate-900">Email our team</p>
              <a href={"mailto:" + supportEmail} className="mt-2 inline-block text-sm font-semibold text-violet-700 underline underline-offset-2">{supportEmail}</a>
            </div>
          )}
          {slug === "contact" && !supportEmail && (
            <p className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">A dedicated support email has not been published for this deployment yet. Account access links are available below.</p>
          )}
          <div className="mt-10 space-y-8">
            {page.sections.map((section) => (
              <section key={section.heading} className="border-t border-slate-100 pt-7">
                <h2 className="text-lg font-semibold tracking-tight text-slate-950">{section.heading}</h2>
                {section.paragraphs.map((paragraph) => <p key={paragraph} className="mt-3 leading-7 text-slate-600">{paragraph}</p>)}
                {section.bullets && (
                  <ul className="mt-3 list-disc space-y-2 pl-5 leading-7 text-slate-600">
                    {section.bullets.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                )}
              </section>
            ))}
          </div>
          <div className="mt-10 flex flex-wrap gap-3 border-t border-slate-100 pt-7">
            <Link href={base + "/register"} className="rounded-xl bg-violet-600 px-5 py-3 text-sm font-semibold text-white hover:bg-violet-700">Create an account</Link>
            <Link href={base + "/login"} className="rounded-xl border border-slate-200 px-5 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">Sign in</Link>
            {slug !== "contact" && <Link href={base + "/contact"} className="rounded-xl border border-slate-200 px-5 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">Contact</Link>}
          </div>
        </div>
      </div>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-5 py-6 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-10">
          <Link href={base} className="font-bold text-slate-950">supa<span className="text-violet-600">.</span></Link>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            <Link href={base + "/about"} className="hover:text-violet-700">About</Link>
            <Link href={base + "/privacy"} className="hover:text-violet-700">Privacy</Link>
            <Link href={base + "/terms"} className="hover:text-violet-700">Terms</Link>
            <Link href={base + "/contact"} className="hover:text-violet-700">Contact</Link>
          </div>
        </div>
      </footer>
    </main>
  );
}
