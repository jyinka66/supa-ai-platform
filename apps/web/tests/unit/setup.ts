import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// Auto-cleanup between React tests so the DOM doesn't leak state.
afterEach(() => {
  cleanup();
});

// Stub PostHog so tests don't try to hit the network.
vi.mock("@/lib/analytics/posthog", () => ({
  posthog: {
    capture: vi.fn(),
    identify: vi.fn(),
    has_opted_out_capturing: false,
  },
}));

// Stub Supabase client — individual tests override with vi.mocked().
vi.mock("@/lib/supabase/client", () => ({
  supabaseBrowser: {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
      signInWithPassword: vi.fn(),
      signOut: vi.fn(),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    })),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  },
}));
