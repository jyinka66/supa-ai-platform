import { ExpansionDashboard } from "@/components/expansion/expansion-dashboard";

export const metadata = { title: "Expansion — Admin" };

export default function ExpansionPage() {
  return (
    <div className="min-h-screen bg-surfaceMuted p-lg">
      <ExpansionDashboard />
    </div>
  );
}
