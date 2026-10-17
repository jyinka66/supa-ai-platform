"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea, Label } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { supaOsApi, ApiClientError } from "@/lib/api-client";

export function BuildSessionCreator() {
  const router = useRouter();
  const [prompt, setPrompt] = React.useState("");
  const [platform, setPlatform] = React.useState<"web" | "mobile" | "full_stack">("web");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [parsedGoal, setParsedGoal] = React.useState<{ domain: string; compliance: string[]; platforms: string[] } | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (prompt.length < 10) {
      setError("Prompt must be at least 10 characters");
      return;
    }
    setLoading(true);
    setError(null);
    setParsedGoal(null);
    try {
      const result = await supaOsApi.build.create({ prompt, platform });
      setParsedGoal(result.parsedGoal);
      // Navigate to the live build view after a short delay.
      setTimeout(() => {
        router.push(`/admin/supa-os/build/${result.session.id}`);
      }, 800);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(`${err.code}: ${err.message}`);
      } else {
        setError("Failed to create build session. Please try again.");
      }
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-lg">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Create a new build</CardTitle>
          <p className="text-sm text-textMuted">
            Describe what you want to build in plain English. Supa OS will plan the architecture, scaffold the
            code, run tests, deploy a live preview, and publish to your target of choice.
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-md">
            <div className="space-y-sm">
              <Label htmlFor="prompt">Prompt</Label>
              <Textarea
                id="prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Build a fintech app for the Nigerian market — BVN verification, NGN wallet, mobile money transfers, MFA auth, and a transaction ledger with double-entry bookkeeping."
                className="min-h-[160px] font-mono text-sm"
                disabled={loading}
                autoFocus
              />
              <p className="text-xs text-textMuted">
                {prompt.length}/10000 characters · minimum 10
              </p>
            </div>

            <div className="space-y-sm">
              <Label>Platform</Label>
              <div className="flex gap-sm">
                {(["web", "mobile", "full_stack"] as const).map((p) => (
                  <Button
                    key={p}
                    type="button"
                    variant={platform === p ? "default" : "outline"}
                    size="sm"
                    onClick={() => setPlatform(p)}
                    disabled={loading}
                  >
                    {p === "full_stack" ? "Full Stack" : p.charAt(0).toUpperCase() + p.slice(1)}
                  </Button>
                ))}
              </div>
            </div>

            {error && (
              <div className="rounded-md border border-danger/30 bg-danger/10 p-md text-sm text-danger">
                {error}
              </div>
            )}

            {parsedGoal && (
              <div className="rounded-md border border-success/30 bg-success/10 p-md space-y-sm">
                <div className="flex items-center gap-sm">
                  <Badge variant="success">Goal parsed</Badge>
                  <span className="text-sm font-medium">Domain: {parsedGoal.domain}</span>
                </div>
                {parsedGoal.compliance.length > 0 && (
                  <div className="flex flex-wrap gap-sm">
                    <span className="text-xs text-textMuted">Compliance:</span>
                    {parsedGoal.compliance.map((c) => (
                      <Badge key={c} variant="warning">{c}</Badge>
                    ))}
                  </div>
                )}
                {parsedGoal.platforms.length > 0 && (
                  <div className="flex flex-wrap gap-sm">
                    <span className="text-xs text-textMuted">Platforms detected:</span>
                    {parsedGoal.platforms.map((p) => (
                      <Badge key={p} variant="outline">{p}</Badge>
                    ))}
                  </div>
                )}
                <p className="text-xs text-textMuted">
                  Redirecting to live build view…
                </p>
              </div>
            )}

            <div className="flex justify-end gap-sm">
              <Button
                type="button"
                variant="outline"
                onClick={() => { setPrompt(""); setError(null); setParsedGoal(null); }}
                disabled={loading || !prompt}
              >
                Clear
              </Button>
              <Button type="submit" disabled={loading || prompt.length < 10}>
                {loading ? "Creating build…" : "Create build"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Example prompts</CardTitle>
        </CardHeader>
        <CardContent className="space-y-sm">
          {EXAMPLE_PROMPTS.map((ex) => (
            <button
              key={ex.title}
              type="button"
              onClick={() => setPrompt(ex.prompt)}
              className="block w-full text-left rounded-md border border-border p-md hover:bg-surfaceMuted transition-colors"
            >
              <div className="font-medium text-sm">{ex.title}</div>
              <div className="text-xs text-textMuted mt-1">{ex.prompt}</div>
            </button>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

const EXAMPLE_PROMPTS = [
  {
    title: "Fintech App (Nigeria)",
    prompt: "Build a fintech wallet for the Nigerian market. BVN verification via Mono, NGN wallet with double-entry ledger, mobile money transfers via Paystack, MFA auth with TOTP, and PCI-DSS compliance.",
  },
  {
    title: "Healthcare Portal (US)",
    prompt: "Build a patient portal for a US healthcare provider. HIPAA-compliant, FHIR R4 API, patient appointments, lab results, secure messaging, SMART-on-FHIR auth.",
  },
  {
    title: "E-commerce (Multi-region)",
    prompt: "Build a multi-region e-commerce platform with i18n for English, French, Spanish, German. Stripe + Flutterwave + Paystack payment methods, inventory management, and a seller dashboard.",
  },
  {
    title: "Internal CRM",
    prompt: "Build an internal CRM for a B2B SaaS company. Lead management, pipeline tracking, deal workflows, SSO with SAML, role-based access (admin/sales/manager), and activity timeline.",
  },
];
