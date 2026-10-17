"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { supaOsApi, type LoanSummary } from "@/lib/api-client";

export function LoanCalculator() {
  const [principal, setPrincipal] = React.useState("100000");
  const [rate, setRate] = React.useState("12");
  const [term, setTerm] = React.useState("12");
  const [summary, setSummary] = React.useState<LoanSummary | null>(null);
  const [schedule, setSchedule] = React.useState<Array<{ month: number; payment: number; principal: number; interest: number; balance: number }>>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function calculate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const result = await supaOsApi.loan.calculate({
        principal: parseFloat(principal),
        annualInterestRate: parseFloat(rate),
        termMonths: parseInt(term, 10),
      });
      setSummary(result.summary);
      setSchedule(result.schedule.schedule);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to calculate");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-lg">
      <div>
        <h1 className="text-2xl font-bold">Loan Calculator</h1>
        <p className="text-sm text-textMuted mt-1">
          Calculate amortization schedules using the spec-exact formula from the loan-banking engine.
        </p>
      </div>

      <div className="grid grid-cols-12 gap-md">
        <Card className="col-span-4">
          <CardHeader>
            <CardTitle>Loan parameters</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={calculate} className="space-y-md">
              <div className="space-y-sm">
                <Label htmlFor="principal">Principal (USD)</Label>
                <Input id="principal" type="number" value={principal} onChange={(e) => setPrincipal(e.target.value)} min={1} max={10_000_000} />
              </div>
              <div className="space-y-sm">
                <Label htmlFor="rate">Annual Interest Rate (%)</Label>
                <Input id="rate" type="number" value={rate} onChange={(e) => setRate(e.target.value)} min={0} max={100} step={0.01} />
              </div>
              <div className="space-y-sm">
                <Label htmlFor="term">Term (months)</Label>
                <Input id="term" type="number" value={term} onChange={(e) => setTerm(e.target.value)} min={1} max={360} />
              </div>
              {error && <div className="text-sm text-danger">{error}</div>}
              <Button type="submit" disabled={loading} className="w-full">
                {loading ? "Calculating…" : "Calculate"}
              </Button>
            </form>
          </CardContent>
        </Card>

        {summary && (
          <Card className="col-span-8">
            <CardHeader>
              <CardTitle>Summary</CardTitle>
              <CardDescription>The loan parameters and computed totals.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-md">
                <Stat label="Monthly Payment" value={`$${summary.monthlyPayment.toFixed(2)}`} />
                <Stat label="Total Payment" value={`$${summary.totalPayment.toFixed(2)}`} />
                <Stat label="Total Interest" value={`$${summary.totalInterest.toFixed(2)}`} highlight />
                <Stat label="Effective Rate" value={`${summary.effectiveRate.toFixed(2)}%`} />
                <Stat label="Principal" value={`$${summary.principal.toFixed(2)}`} />
                <Stat label="Term" value={`${summary.termMonths} months`} />
              </div>

              <div className="mt-lg">
                <h3 className="text-sm font-semibold mb-sm">Amortization Schedule</h3>
                <div className="rounded-md border border-border overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-surfaceMuted text-textMuted">
                      <tr>
                        <th className="text-left p-sm">Month</th>
                        <th className="text-right p-sm">Payment</th>
                        <th className="text-right p-sm">Principal</th>
                        <th className="text-right p-sm">Interest</th>
                        <th className="text-right p-sm">Balance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {schedule.map((row) => (
                        <tr key={row.month} className="border-t border-border">
                          <td className="p-sm">{row.month}</td>
                          <td className="p-sm text-right">${row.payment.toFixed(2)}</td>
                          <td className="p-sm text-right">${row.principal.toFixed(2)}</td>
                          <td className="p-sm text-right text-warning">${row.interest.toFixed(2)}</td>
                          <td className="p-sm text-right font-medium">${row.balance.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="rounded-md border border-border p-md">
      <div className="text-xs text-textMuted">{label}</div>
      <div className={`text-lg font-semibold mt-1 ${highlight ? "text-warning" : "text-text"}`}>{value}</div>
    </div>
  );
}
