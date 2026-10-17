import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "Supa AI",
  description: "Supa AI — workspace-grade auth, billing, and onboarding.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh bg-surface text-text antialiased">
        {children}
      </body>
    </html>
  );
}
