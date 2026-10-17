import { GovernanceDashboard } from "@/components/governance/governance-dashboard";

export const metadata = { title: "Governance — Admin" };

export default function GovernancePage() {
  return (
    <div className="min-h-screen bg-surfaceMuted p-lg">
      <GovernanceDashboard />
    </div>
  );
}
