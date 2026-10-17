import { MarketplaceBrowser } from "@/components/supa-os/marketplace-browser";

export const metadata = { title: "Marketplace — Supa OS" };

export default function MarketplacePage() {
  return (
    <div className="min-h-screen bg-surfaceMuted p-lg">
      <MarketplaceBrowser />
    </div>
  );
}
