import { BuildSessionCreator } from "@/components/supa-os/build-session-creator";

export const metadata = {
  title: "Supa OS — Dashboard",
};

export default function SupaOsDashboardPage() {
  return (
    <div className="min-h-screen bg-surfaceMuted">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto max-w-7xl px-lg py-md flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Supa OS</h1>
            <p className="text-sm text-textMuted">Build complete applications from natural language.</p>
          </div>
          <nav className="flex gap-sm text-sm">
            <a href="/admin/supa-os" className="px-md py-sm rounded-md bg-accent/10 text-accent">Builds</a>
            <a href="/admin/supa-os/marketplace" className="px-md py-sm rounded-md hover:bg-surfaceMuted">Marketplace</a>
            <a href="/admin/supa-os/loan" className="px-md py-sm rounded-md hover:bg-surfaceMuted">Loan Calc</a>
            <a href="/admin/governance" className="px-md py-sm rounded-md hover:bg-surfaceMuted">Governance</a>
            <a href="/admin/expansion" className="px-md py-sm rounded-md hover:bg-surfaceMuted">Expansion</a>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-lg py-lg">
        <BuildSessionCreator />
      </main>
    </div>
  );
}
