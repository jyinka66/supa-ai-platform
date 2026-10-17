"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Textarea, Label } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import {
  Activity, Zap, Send, FileText, Users, BarChart3,
  Bot, Power, RefreshCw, Sparkles, Check, X, Edit,
} from "lucide-react";
import { ContentRepurposer } from "@/components/freelancer/content-repurposer";

// Dark theme tokens — the blueprint specifies obsidian/charcoal + electric cyan.
const DARK = {
  bg: "#0B0F17",
  surface: "#111827",
  surfaceMuted: "#1F2937",
  border: "#374151",
  text: "#F9FAFB",
  textMuted: "#9CA3AF",
  accent: "#00F0FF",
  accentHover: "#00D4DD",
  success: "#10B981",
  warning: "#F59E0B",
  danger: "#EF4444",
};

const NAV_ITEMS = [
  { id: "stream", label: "Live Job Stream", icon: Activity },
  { id: "bids", label: "Active Bids", icon: Zap },
  { id: "proposals", label: "Proposal Vault", icon: FileText },
  { id: "portfolio", label: "Portfolio", icon: Sparkles },
  { id: "crm", label: "CRM / Clients", icon: Users },
  { id: "analytics", label: "Bid Analytics", icon: BarChart3 },
  { id: "repurpose", label: "Content Repurposer", icon: Bot },
] as const;

type NavId = typeof NAV_ITEMS[number]["id"];

export function FreelancerHub() {
  const [activeView, setActiveView] = React.useState<NavId>("stream");
  const [autoBidOn, setAutoBidOn] = React.useState(false);
  const [bidsToday, setBidsToday] = React.useState(7);
  const [maxBidsPerDay] = React.useState(20);

  return (
    <div className="min-h-screen" style={{ background: DARK.bg, color: DARK.text }}>
      {/* Top bar */}
      <header className="border-b flex items-center justify-between px-lg py-md" style={{ borderColor: DARK.border, background: DARK.surface }}>
        <div className="flex items-center gap-md">
          <h1 className="text-xl font-bold" style={{ color: DARK.accent }}>Freelancer Hub</h1>
          <Badge variant="outline" style={{ borderColor: DARK.accent, color: DARK.accent }}>Supa AI</Badge>
        </div>
        <div className="flex items-center gap-md">
          {/* Auto-bid toggle */}
          <button
            onClick={() => setAutoBidOn((p) => !p)}
            className="flex items-center gap-sm px-md py-sm rounded-md text-sm font-medium transition-colors"
            style={{
              background: autoBidOn ? DARK.accent : DARK.surfaceMuted,
              color: autoBidOn ? DARK.bg : DARK.textMuted,
            }}
          >
            <Power className="w-3 h-3" />
            Auto-Bid: {autoBidOn ? "ON" : "OFF"}
          </button>
          {/* Bid counter */}
          <div className="flex items-center gap-sm text-sm">
            <span style={{ color: DARK.textMuted }}>Today:</span>
            <span style={{ color: autoBidOn ? DARK.accent : DARK.text }}>{bidsToday}/{maxBidsPerDay} bids</span>
          </div>
          {/* API status */}
          <Badge variant="outline" style={{ borderColor: DARK.success, color: DARK.success }}>
            <span className="w-2 h-2 rounded-full mr-1 inline-block" style={{ background: DARK.success }} /> API Connected
          </Badge>
        </div>
      </header>

      <div className="flex">
        {/* Sidebar */}
        <nav className="w-56 border-r min-h-[calc(100vh-60px)] py-md" style={{ borderColor: DARK.border, background: DARK.surface }}>
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                onClick={() => setActiveView(item.id)}
                className="flex items-center gap-sm w-full text-left px-md py-sm text-sm transition-colors"
                style={{
                  color: activeView === item.id ? DARK.accent : DARK.textMuted,
                  background: activeView === item.id ? `${DARK.accent}10` : "transparent",
                  borderRight: activeView === item.id ? `2px solid ${DARK.accent}` : "2px solid transparent",
                }}
              >
                <Icon className="w-4 h-4" />
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* Main content */}
        <main className="flex-1 p-lg">
          {activeView === "stream" && <JobStreamView autoBidOn={autoBidOn} />}
          {activeView === "bids" && <ActiveBidsView />}
          {activeView === "proposals" && <ProposalVaultView />}
          {activeView === "portfolio" && <PortfolioView />}
          {activeView === "crm" && <CrmView />}
          {activeView === "analytics" && <AnalyticsView />}
          {activeView === "repurpose" && <ContentRepurposer />}
        </main>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────
// Job Stream — split view (left: jobs, right: proposal workspace)
// ───────────────────────────────────────────────

function JobStreamView({ autoBidOn }: { autoBidOn: boolean }) {
  return (
    <div className="grid grid-cols-12 gap-md h-[calc(100vh-120px)]">
      {/* Left pane: job stream */}
      <div className="col-span-7 flex flex-col">
        <Card style={{ background: DARK.surface, borderColor: DARK.border, flex: 1, display: "flex", flexDirection: "column" }}>
          <CardHeader style={{ paddingBottom: "0.5rem" }}>
            <CardTitle className="flex items-center justify-between" style={{ color: DARK.text }}>
              <span>Live Job Stream</span>
              <Button size="sm" variant="outline" style={{ borderColor: DARK.border, color: DARK.textMuted }}>
                <RefreshCw className="w-3 h-3 mr-1" /> Refresh
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent style={{ flex: 1, overflow: "hidden" }}>
            <ScrollArea className="h-full">
              {SAMPLE_JOBS.map((job) => (
                <div
                  key={job.id}
                  className="rounded-md border p-md mb-sm cursor-pointer hover:border-cyan-400 transition-colors"
                  style={{ borderColor: DARK.border, background: DARK.surfaceMuted }}
                >
                  <div className="flex items-start justify-between mb-1">
                    <div>
                      <span className="font-medium text-sm" style={{ color: DARK.text }}>{job.title}</span>
                      <Badge variant="outline" className="ml-sm" style={{ borderColor: DARK.accent, color: DARK.accent }}>{job.platform}</Badge>
                    </div>
                    <MatchScoreBadge score={job.matchScore} />
                  </div>
                  <p className="text-xs mb-sm" style={{ color: DARK.textMuted }}>{job.description.slice(0, 120)}…</p>
                  <div className="flex items-center gap-md text-xs" style={{ color: DARK.textMuted }}>
                    <span>💰 ${job.budget}</span>
                    <span>⭐ {job.clientRating}</span>
                    {job.verifiedPayment && <span style={{ color: DARK.success }}>✓ Verified</span>}
                    <span>📍 {job.location}</span>
                  </div>
                  {autoBidOn && job.matchScore >= 90 && (
                    <div className="mt-sm flex items-center gap-sm">
                      <Badge variant="success" style={{ background: `${DARK.success}20`, color: DARK.success, borderColor: DARK.success }}>
                        <Zap className="w-3 h-3 mr-1" /> Auto-bid eligible
                      </Badge>
                    </div>
                  )}
                </div>
              ))}
            </ScrollArea>
          </CardContent>
        </Card>
      </div>

      {/* Right pane: AI proposal workspace */}
      <div className="col-span-5 flex flex-col">
        <Card style={{ background: DARK.surface, borderColor: DARK.border, flex: 1, display: "flex", flexDirection: "column" }}>
          <CardHeader style={{ paddingBottom: "0.5rem" }}>
            <CardTitle style={{ color: DARK.text }}>AI Proposal Workspace</CardTitle>
          </CardHeader>
          <CardContent style={{ flex: 1, display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <div>
              <Label style={{ color: DARK.textMuted }}>Tone</Label>
              <div className="flex gap-sm mt-1">
                {["consultative", "direct", "bold"].map((t) => (
                  <Button key={t} size="sm" variant="outline" style={{ borderColor: DARK.border, color: DARK.textMuted }}>
                    {t}
                  </Button>
                ))}
              </div>
            </div>
            <div className="flex-1">
              <Label style={{ color: DARK.textMuted }}>Generated Proposal</Label>
              <Textarea
                className="mt-1"
                style={{ background: DARK.surfaceMuted, color: DARK.text, borderColor: DARK.border, minHeight: "200px" }}
                placeholder="Select a job from the stream to generate a proposal…"
                defaultValue={SAMPLE_PROPOSAL}
              />
            </div>
            <div className="flex gap-sm">
              <Button size="sm" style={{ background: DARK.accent, color: DARK.bg }}>
                <Send className="w-3 h-3 mr-1" /> Submit Bid
              </Button>
              <Button size="sm" variant="outline" style={{ borderColor: DARK.border, color: DARK.textMuted }}>
                <Edit className="w-3 h-3 mr-1" /> Edit
              </Button>
              <Button size="sm" variant="outline" style={{ borderColor: DARK.border, color: DARK.textMuted }}>
                Send to Slack
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function MatchScoreBadge({ score }: { score: number }) {
  const color = score >= 85 ? DARK.success : score >= 65 ? DARK.warning : DARK.danger;
  return (
    <div className="flex items-center gap-1">
      <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold" style={{ background: `${color}20`, color }}>
        {score}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────
// Other views (simplified for Phase 1)
// ───────────────────────────────────────────────

function ActiveBidsView() {
  return <PlaceholderView title="Active Bids" icon={Zap} description="Track bids you've submitted — pending, won, lost." />;
}
function ProposalVaultView() {
  return <PlaceholderView title="Proposal Vault" icon={FileText} description="Browse, search, and reuse past proposals." />;
}
function PortfolioView() {
  return <PlaceholderView title="Portfolio Embeddings" icon={Sparkles} description="Manage your portfolio items — the AI uses these for semantic matching." />;
}
function CrmView() {
  return <PlaceholderView title="CRM / Clients" icon={Users} description="Direct client relationships, contracts, milestones." />;
}

function AnalyticsView() {
  const stats = [
    { label: "Total Bids", value: "147" },
    { label: "Conversion Rate", value: "32%" },
    { label: "Avg Contract Value", value: "$2,450" },
    { label: "Total Revenue", value: "$48,200" },
    { label: "Auto-Bid Win Rate", value: "28%" },
    { label: "Manual Win Rate", value: "41%" },
  ];
  return (
    <div className="space-y-lg">
      <h2 className="text-lg font-semibold" style={{ color: DARK.text }}>Bid Analytics Dashboard</h2>
      <div className="grid grid-cols-3 gap-md">
        {stats.map((s) => (
          <Card key={s.label} style={{ background: DARK.surface, borderColor: DARK.border }}>
            <CardContent className="p-md">
              <div className="text-xs" style={{ color: DARK.textMuted }}>{s.label}</div>
              <div className="text-2xl font-bold mt-1" style={{ color: DARK.accent }}>{s.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card style={{ background: DARK.surface, borderColor: DARK.border }}>
        <CardHeader><CardTitle style={{ color: DARK.text }}>Win Rate by Match Score</CardTitle></CardHeader>
        <CardContent>
          {[
            { bucket: "95-100%", rate: 0.65, bids: 12 },
            { bucket: "85-95%", rate: 0.45, bids: 28 },
            { bucket: "70-85%", rate: 0.22, bids: 45 },
            { bucket: "50-70%", rate: 0.10, bids: 38 },
            { bucket: "0-50%", rate: 0.03, bids: 24 },
          ].map((b) => (
            <div key={b.bucket} className="flex items-center gap-md mb-sm">
              <span className="text-xs w-16" style={{ color: DARK.textMuted }}>{b.bucket}</span>
              <div className="flex-1"><Progress value={b.rate * 100} indicatorClassName="bg-cyan-400" /></div>
              <span className="text-xs w-12 text-right" style={{ color: DARK.text }}>{Math.round(b.rate * 100)}%</span>
              <span className="text-xs" style={{ color: DARK.textMuted }}>({b.bids} bids)</span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

// Content Repurposer is now its own component — see content-repurposer.tsx.
// The old inline ContentRepurposerView used hardcoded mock data; it's been
// replaced with the production ContentRepurposer that calls the real API.

function PlaceholderView({ title, icon: Icon, description }: { title: string; icon: React.ComponentType<{ className?: string }>; description: string }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[400px]">
      <Icon className="w-12 h-12 mb-md" />
      <h2 className="text-lg font-semibold" style={{ color: DARK.text }}>{title}</h2>
      <p className="text-sm mt-1" style={{ color: DARK.textMuted }}>{description}</p>
    </div>
  );
}

// ───────────────────────────────────────────────
// Sample data
// ───────────────────────────────────────────────

const SAMPLE_JOBS = [
  { id: "job_1", title: "Build a fintech wallet app with BVN verification", platform: "upwork", matchScore: 94, budget: "3000", clientRating: 4.8, verifiedPayment: true, location: "NG", description: "We need a developer to build a fintech wallet app for the Nigerian market with BVN verification via Mono, NGN wallet, and mobile money transfers via Paystack." },
  { id: "job_2", title: "React Native developer for e-commerce app", platform: "upwork", matchScore: 82, budget: "2500", clientRating: 4.5, verifiedPayment: true, location: "US", description: "Looking for an experienced React Native developer to build a cross-platform e-commerce app with Stripe payments and product catalog." },
  { id: "job_3", title: "Next.js dashboard with Supabase auth", platform: "fiverr", matchScore: 78, budget: "800", clientRating: 4.2, verifiedPayment: false, location: "UK", description: "I need an admin dashboard built with Next.js App Router and Supabase authentication. Should include charts, tables, and CRUD operations." },
  { id: "job_4", title: "Full-stack developer for SaaS MVP", platform: "direct", matchScore: 71, budget: "5000", clientRating: 4.9, verifiedPayment: true, location: "CA", description: "We're building a SaaS MVP and need a full-stack developer with experience in Next.js, PostgreSQL, and Stripe billing." },
  { id: "job_5", title: "WordPress site maintenance", platform: "upwork", matchScore: 35, budget: "200", clientRating: 3.8, verifiedPayment: false, location: "IN", description: "Need someone to maintain our existing WordPress site, update plugins, and fix minor bugs." },
];

const SAMPLE_PROPOSAL = `Hi there,

I've built several fintech wallet apps for the Nigerian market, including a BVN-verified wallet with Mono integration and Paystack mobile money transfers.

Here's how I'd approach your project:

1. **BVN Verification** — Integrate Mono's BVN verification API with a secure, encrypted flow.
2. **NGN Wallet** — Double-entry ledger with immutable transaction records.
3. **Mobile Money** — Paystack integration for transfers and bill payments.
4. **Security** — PCI-DSS compliant, AES-256 encryption at rest, RBAC.

I can deliver this in 4-6 weeks with a milestone breakdown. Let's discuss the details.

Best regards`;
