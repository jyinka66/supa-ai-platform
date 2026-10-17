import { LoanCalculator } from "@/components/supa-os/loan-calculator";

export const metadata = { title: "Loan Calculator — Supa OS" };

export default function LoanPage() {
  return (
    <div className="min-h-screen bg-surfaceMuted p-lg">
      <LoanCalculator />
    </div>
  );
}
