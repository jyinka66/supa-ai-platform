"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { governanceApi, type KillSwitch, type CircuitBreaker, type AuditEntry } from "@/lib/api-client";
import { AlertTriangle, Shield, FileText, Power } from "lucide-react";

export function GovernanceDashboard() {
  const [killSwitches, setKillSwitches] = React.useState<KillSwitch[]>([]);
  const [breakers, setBreakers] = React.useState<CircuitBreaker[]>([]);
  const [audit, setAudit] = React.useState<AuditEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ks, cb, aud] = await Promise.all([
        governanceApi.killSwitches.list(),
        governanceApi.circuitBreakers.list(),
        governanceApi.audit.list({ limit: 50 }),
      ]);
      setKillSwitches(ks.switches);
      setBreakers(cb.breakers);
      setAudit(aud.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load governance data");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const activeKillSwitches = killSwitches.filter((k) => k.isActive);
  const openBreakers = breakers.filter((b) => b.state === "open");

  return (
    <div className="mx-auto max-w-7xl space-y-lg">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Governance</h1>
          <p className="text-sm text-textMuted mt-1">Decisions, kill switches, circuit breakers, and the audit trail.</p>
        </div>
        <Button variant="outline" onClick={load}>Refresh</Button>
      </div>

      {(activeKillSwitches.length > 0 || openBreakers.length > 0) && (
        <div className="rounded-md border border-danger/30 bg-danger/10 p-md flex items-center gap-md">
          <AlertTriangle className="w-5 h-5 text-danger shrink-0" />
          <div className="flex-1 text-sm">
            <div className="font-medium text-danger">
              {activeKillSwitches.length} active kill switch{activeKillSwitches.length !== 1 ? "es" : ""}
              {openBreakers.length > 0 && `, ${openBreakers.length} open circuit breaker${openBreakers.length !== 1 ? "s" : ""}`}
            </div>
            <div className="text-textMuted text-xs mt-1">Investigate before resuming normal operations.</div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-md">
        <KpiCard label="Active Kill Switches" value={activeKillSwitches.length} icon={Power} variant={activeKillSwitches.length > 0 ? "danger" : "default"} />
        <KpiCard label="Open Circuit Breakers" value={openBreakers.length} icon={AlertTriangle} variant={openBreakers.length > 0 ? "warning" : "default"} />
        <KpiCard label="Total Kill Switch Types" value={killSwitches.length} icon={Shield} />
        <KpiCard label="Audit Entries (last 50)" value={audit.length} icon={FileText} />
      </div>

      {error && <div className="text-sm text-danger">{error}</div>}

      <Tabs defaultValue="kill-switches">
        <TabsList>
          <TabsTrigger value="kill-switches">Kill Switches</TabsTrigger>
          <TabsTrigger value="circuit-breakers">Circuit Breakers</TabsTrigger>
          <TabsTrigger value="audit">Audit Trail</TabsTrigger>
        </TabsList>

        <TabsContent value="kill-switches">
          <Card>
            <CardHeader>
              <CardTitle>Kill Switches</CardTitle>
              <CardDescription>Global + scoped emergency stop switches. 60-second propagation SLA.</CardDescription>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[500px]">
                <table className="w-full text-sm">
                  <thead className="text-xs text-textMuted sticky top-0 bg-surface">
                    <tr>
                      <th className="text-left p-sm">Status</th>
                      <th className="text-left p-sm">Key</th>
                      <th className="text-left p-sm">Scope</th>
                      <th className="text-left p-sm">Activated By</th>
                      <th className="text-left p-sm">Activated At</th>
                      <th className="text-left p-sm">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {killSwitches.map((ks) => (
                      <tr key={ks.id} className="border-t border-border">
                        <td className="p-sm">
                          {ks.isActive ? <Badge variant="danger">Active</Badge> : <Badge variant="outline">Inactive</Badge>}
                        </td>
                        <td className="p-sm font-mono text-xs">{ks.key}</td>
                        <td className="p-sm">{ks.scopeType}</td>
                        <td className="p-sm text-xs">{ks.activatedBy ?? "—"}</td>
                        <td className="p-sm text-xs">{ks.activatedAt ? new Date(ks.activatedAt).toLocaleString() : "—"}</td>
                        <td className="p-sm text-xs text-textMuted">{ks.activationReason ?? "—"}</td>
                      </tr>
                    ))}
                    {killSwitches.length === 0 && (
                      <tr><td colSpan={6} className="p-md text-center text-textMuted">No kill switches configured.</td></tr>
                    )}
                  </tbody>
                </table>
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="circuit-breakers">
          <Card>
            <CardHeader>
              <CardTitle>Circuit Breakers</CardTitle>
              <CardDescription>Automatic breakers for cost, latency, errors, abuse, and compliance.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-md">
                {breakers.map((b, i) => (
                  <div key={i} className="rounded-md border border-border p-md">
                    <div className="flex items-center justify-between">
                      <div className="font-medium text-sm">{b.spec.title}</div>
                      <Badge variant={b.state === "open" ? "danger" : b.state === "half_open" ? "warning" : "success"}>
                        {b.state}
                      </Badge>
                    </div>
                    <div className="text-xs text-textMuted mt-1">{b.spec.description}</div>
                    <div className="text-xs mt-2">Unit: {b.spec.unit}</div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="audit">
          <Card>
            <CardHeader>
              <CardTitle>Audit Trail</CardTitle>
              <CardDescription>The last 50 audit entries across all categories.</CardDescription>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[500px]">
                <table className="w-full text-sm">
                  <thead className="text-xs text-textMuted sticky top-0 bg-surface">
                    <tr>
                      <th className="text-left p-sm">When</th>
                      <th className="text-left p-sm">Actor</th>
                      <th className="text-left p-sm">Action</th>
                      <th className="text-left p-sm">Target</th>
                      <th className="text-left p-sm">Category</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.map((entry) => (
                      <tr key={entry.id} className="border-t border-border">
                        <td className="p-sm text-xs">{new Date(entry.createdAt).toLocaleString()}</td>
                        <td className="p-sm font-mono text-xs">{entry.actor}</td>
                        <td className="p-sm font-mono text-xs">{entry.action}</td>
                        <td className="p-sm text-xs">{entry.targetType}/{entry.targetId}</td>
                        <td className="p-sm"><Badge variant="outline">{entry.category}</Badge></td>
                      </tr>
                    ))}
                    {audit.length === 0 && (
                      <tr><td colSpan={5} className="p-md text-center text-textMuted">No audit entries.</td></tr>
                    )}
                  </tbody>
                </table>
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function KpiCard({ label, value, icon: Icon, variant = "default" }: {
  label: string;
  value: number | string;
  icon: React.ComponentType<{ className?: string }>;
  variant?: "default" | "warning" | "danger";
}) {
  const color = variant === "danger" ? "text-danger" : variant === "warning" ? "text-warning" : "text-accent";
  return (
    <Card>
      <CardContent className="p-md flex items-center gap-md">
        <Icon className={`w-8 h-8 ${color}`} />
        <div>
          <div className="text-xs text-textMuted">{label}</div>
          <div className="text-2xl font-bold">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}
