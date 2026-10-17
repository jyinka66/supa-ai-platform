"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryStreamedHydration } from "@tanstack/react-query-next-experimental";
import type { ReactNode } from "react";
import { useState } from "react";
import { posthog } from "@/lib/analytics/posthog";

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: (failureCount, error) => {
              // Don't retry on 4xx — these won't fix themselves.
              const status = (error as { status?: number }).status;
              if (status !== undefined && status >= 400 && status < 500) return false;
              return failureCount < 2;
            },
          },
        },
      }),
  );

  // PostHog opt-out for users who haven't consented (placeholder — wire to cookie banner).
  if (typeof window !== "undefined" && !posthog.has_opted_out_capturing) {
    // intentionally left as default opt-in for now
  }

  return (
    <QueryClientProvider client={client}>
      <ReactQueryStreamedHydration>{children}</ReactQueryStreamedHydration>
    </QueryClientProvider>
  );
}
