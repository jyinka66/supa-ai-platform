import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { ErrorState } from "@supa/ui/error-state";

export const revalidate = 60; // ISR — re-render at most every 60s

interface ProviderStat {
  day: string;
  provider: string;
  requests: number;
  output_tokens: number;
  input_tokens: number;
  cost_usd: string;
  avg_ttfb_ms: number | null;
  p95_ttfb_ms: number | null;
  p95_total_ms: number | null;
  retry_count: number;
  fallback_count: number;
}

interface BudgetBurn {
  budget_id: string;
  scope_type: "user" | "workspace";
  scope_id: string;
  cost_limit_usd: string;
  alert_threshold: string;
  mtd_usd: string;
  pct_used: string;
  projected_30d_usd: string;
  status: "ok" | "alert" | "exceeded";
}

interface FailureRow {
  provider: string;
  total_failures: number;
  avg_retries: string | null;
}

interface PromptPerfRow {
  prompt_version: string;
  language: string;
  thumbs_up: number;
  thumbs_down: number;
  approval_pct: string;
}

interface MetricsResponse {
  ok: boolean;
  data: {
    providerStats: ProviderStat[];
    budgetBurn: BudgetBurn[];
    failures: FailureRow[];
    promptPerf: PromptPerfRow[];
    generatedAt: string;
    lookbackDays: number;
  };
}

export default async function AdminPage() {
  // Admin control-plane auth: the page checks for the `supa_admin` cookie
  // presence (defense-in-depth). The actual session verification happens in
  // the API route (requireAdminSession — argon2id token verify, 8h cap,
  // MFA-gated, IP-bound). If the cookie is missing OR the API returns 401,
  // redirect to the admin login.
  const cookieStore = await cookies();
  const adminCookie = cookieStore.get("supa_admin");
  if (!adminCookie?.value) {
    redirect("/en/login?next=/admin");
  }

  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const res = await fetch(`${baseUrl}/api/admin/metrics?days=7`, {
    headers: { cookie: cookieHeader },
    next: { revalidate: 60 },
  });

  // If the admin session is invalid/expired, the API returns 401 — redirect
  // to login. (The admin must re-authenticate via product auth + MFA step-up.)
  if (res.status === 401) {
    redirect("/en/login?next=/admin");
  }

  if (!res.ok) {
    return (
      <main className="mx-auto max-w-6xl p-6">
        <ErrorState
          title="Failed to load metrics"
          description={`Status ${res.status} — try refreshing.`}
          onRetry={() => {
            // Server component — can't use window. Client would need a wrapper.
          }}
        />
      </main>
    );
  }

  const json: MetricsResponse = await res.json();
  const { providerStats, budgetBurn, failures, promptPerf } = json.data;

  return (
    <main className="mx-auto max-w-6xl space-y-8 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Admin · Last {json.data.lookbackDays} days</h1>
        <p className="text-xs text-textMuted">
          Generated {new Date(json.data.generatedAt).toLocaleString()}
        </p>
      </header>

      {/* ============ Provider Stats ============ */}
      <section>
        <h2 className="mb-2 font-medium">Provider stats</h2>
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-surfaceMuted">
              <tr className="text-left text-textMuted">
                <th className="px-3 py-2">Day</th>
                <th className="px-3 py-2">Provider</th>
                <th className="px-3 py-2 text-right">Reqs</th>
                <th className="px-3 py-2 text-right">Cost (USD)</th>
                <th className="px-3 py-2 text-right">p95 TTFB</th>
                <th className="px-3 py-2 text-right">p95 Total</th>
                <th className="px-3 py-2 text-right">Fallbacks</th>
              </tr>
            </thead>
            <tbody>
              {providerStats.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-textMuted">
                    No data in the last 7 days.
                  </td>
                </tr>
              ) : (
                providerStats.map((r) => (
                  <tr key={`${r.day}-${r.provider}`} className="border-t border-border">
                    <td className="px-3 py-2">{String(r.day).slice(0, 10)}</td>
                    <td className="px-3 py-2 font-medium">{r.provider}</td>
                    <td className="px-3 py-2 text-right">{r.requests.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right">${r.cost_usd}</td>
                    <td className="px-3 py-2 text-right">
                      {r.p95_ttfb_ms !== null ? `${r.p95_ttfb_ms}ms` : "—"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {r.p95_total_ms !== null ? `${r.p95_total_ms}ms` : "—"}
                    </td>
                    <td
                      className={`px-3 py-2 text-right ${
                        r.fallback_count > 0 ? "text-warning" : ""
                      }`}
                    >
                      {r.fallback_count}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ============ Budget Burn ============ */}
      <section>
        <h2 className="mb-2 font-medium">Budget burn</h2>
        {budgetBurn.length === 0 ? (
          <p className="rounded-md border border-border bg-surfaceMuted p-4 text-sm text-textMuted">
            No budgets configured.
          </p>
        ) : (
          <div className="space-y-1">
            {budgetBurn.map((b) => {
              const pct = Number(b.pct_used);
              const barColor =
                b.status === "exceeded" || pct > 90
                  ? "bg-danger"
                  : b.status === "alert" || pct > 70
                    ? "bg-warning"
                    : "bg-success";
              return (
                <div key={b.budget_id} className="flex items-center gap-3 py-1 text-sm">
                  <span className="w-56 font-mono text-xs text-textMuted">
                    {b.scope_type}:{b.scope_id.slice(0, 8)}
                  </span>
                  <div className="h-2 flex-1 rounded bg-surfaceMuted">
                    <div
                      className={`h-2 rounded ${barColor} transition-all`}
                      style={{ width: `${Math.min(pct, 100)}%` }}
                    />
                  </div>
                  <span className="w-48 text-right text-xs">
                    ${b.mtd_usd} / ${b.cost_limit_usd} ({b.pct_used}%)
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ============ Failures + Prompt Perf ============ */}
      <section className="grid grid-cols-1 gap-8 md:grid-cols-2">
        <div>
          <h2 className="mb-2 font-medium">Top failures</h2>
          {failures.length === 0 ? (
            <p className="text-sm text-textMuted">No failures in the last 7 days. 🎉</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {failures.map((f) => (
                <li key={f.provider} className="flex items-center justify-between">
                  <span className="font-mono">{f.provider}</span>
                  <span className="text-textMuted">
                    {f.total_failures} failures
                    {f.avg_retries && ` · avg ${f.avg_retries} retries`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h2 className="mb-2 font-medium">Prompt versions (approval %)</h2>
          {promptPerf.length === 0 ? (
            <p className="text-sm text-textMuted">No feedback data yet.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {promptPerf.map((p) => (
                <li key={p.prompt_version} className="flex items-center justify-between">
                  <span className="font-mono text-xs">
                    v{p.prompt_version.slice(0, 12)}
                  </span>
                  <span className="text-textMuted">
                    {p.approval_pct}% ({p.thumbs_up}↑ / {p.thumbs_down}↓)
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </main>
  );
}
