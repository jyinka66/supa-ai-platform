"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { expansionApi, type ExpansionPipeline } from "@/lib/api-client";
import { Globe, Activity, TrendingUp, AlertCircle } from "lucide-react";

const STAGE_COLORS: Record<string, "default" | "success" | "warning" | "danger"> = {
  detected: "default",
  evaluating: "default",
  prioritized: "default",
  preparing: "warning",
  verified: "success",
  soft_launching: "warning",
  launched: "success",
  monitored: "default",
  optimizing: "default",
  failed: "danger",
  retired: "default",
};

export function ExpansionDashboard() {
  const [pipeline, setPipeline] = React.useState<ExpansionPipeline | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [detectionRegion, setDetectionRegion] = React.useState("NG");
  const [detectionResult, setDetectionResult] = React.useState<Record<string, unknown> | null>(null);
  const [runningDetection, setRunningDetection] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await expansionApi.pipeline.get();
      setPipeline(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load pipeline");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  async function runDetection(e: React.FormEvent) {
    e.preventDefault();
    setRunningDetection(true);
    setError(null);
    try {
      const result = await expansionApi.detection.run({ regionCode: detectionRegion });
      setDetectionResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Detection failed");
    } finally {
      setRunningDetection(false);
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-lg">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Regional Expansion</h1>
          <p className="text-sm text-textMuted mt-1">The 9-stage pipeline from detection → optimization.</p>
        </div>
        <Button variant="outline" onClick={load}>Refresh</Button>
      </div>

      {error && <div className="text-sm text-danger">{error}</div>}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-md">
        <KpiCard label="Pipeline Stages" value={pipeline?.stages.length ?? 0} icon={Activity} />
        <KpiCard label="Autonomy Levels" value={pipeline?.autonomyLevels.length ?? 0} icon={TrendingUp} />
        <KpiCard label="Human Checkpoints" value={pipeline?.humanCheckpoints.length ?? 0} icon={AlertCircle} />
      </div>

      <Tabs defaultValue="pipeline">
        <TabsList>
          <TabsTrigger value="pipeline">Pipeline</TabsTrigger>
          <TabsTrigger value="detection">Detection</TabsTrigger>
          <TabsTrigger value="autonomy">Autonomy</TabsTrigger>
        </TabsList>

        <TabsContent value="pipeline">
          <Card>
            <CardHeader>
              <CardTitle>9-Stage Pipeline</CardTitle>
              <CardDescription>The full lifecycle from demand detection to ongoing optimization.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-sm overflow-x-auto pb-md">
                {pipeline?.stages.map((stage, i) => (
                  <div key={stage} className="flex items-center gap-sm">
                    <div className="rounded-md border border-border p-md min-w-[140px]">
                      <div className="text-xs text-textMuted">Stage {i + 1}</div>
                      <div className="font-medium text-sm mt-1 capitalize">{stage.replace(/_/g, " ")}</div>
                      <Badge variant={STAGE_COLORS[stage] ?? "default"} className="mt-sm">{stage}</Badge>
                    </div>
                    {i < pipeline.stages.length - 1 && <div className="text-textMuted">→</div>}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="detection">
          <Card>
            <CardHeader>
              <CardTitle>Run Detection</CardTitle>
              <CardDescription>Detect demand signals for a region (traffic, signups, payments, support).</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={runDetection} className="space-y-md max-w-md">
                <div className="space-y-sm">
                  <Label htmlFor="region">Region Code (ISO 3166-1 alpha-2)</Label>
                  <Input
                    id="region"
                    value={detectionRegion}
                    onChange={(e) => setDetectionRegion(e.target.value.toUpperCase())}
                    placeholder="NG, KE, ZA, …"
                    maxLength={8}
                    pattern="[A-Z_-]+"
                  />
                </div>
                <Button type="submit" disabled={runningDetection || detectionRegion.length < 2}>
                  {runningDetection ? "Detecting…" : "Run detection cycle"}
                </Button>
              </form>

              {detectionResult && (
                <div className="mt-lg">
                  <h3 className="text-sm font-semibold mb-sm">Detection result</h3>
                  <pre className="rounded-md border border-border p-md text-xs font-mono overflow-auto max-h-80">
                    {JSON.stringify(detectionResult, null, 2)}
                  </pre>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="autonomy">
          <Card>
            <CardHeader>
              <CardTitle>Per-Stage Autonomy</CardTitle>
              <CardDescription>How much human oversight each stage requires.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-md">
                {pipeline?.autonomyLevels.map((level) => (
                  <div key={level.stage} className="rounded-md border border-border p-md">
                    <div className="text-sm font-medium capitalize">{level.stage.replace(/_/g, " ")}</div>
                    <Badge variant={level.level === "fully_autonomous" ? "success" : level.level === "human_only" ? "danger" : "warning"} className="mt-sm">
                      {level.level.replace(/_/g, " ")}
                    </Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function KpiCard({ label, value, icon: Icon }: {
  label: string;
  value: number | string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Card>
      <CardContent className="p-md flex items-center gap-md">
        <Icon className="w-8 h-8 text-accent" />
        <div>
          <div className="text-xs text-textMuted">{label}</div>
          <div className="text-2xl font-bold">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}
