import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY — check .env.local",
  );
}

// Cast helper — @supabase/ssr's createServerClient has strict overload types
// that don't match our cookie adapter shape. The runtime works fine; this cast
// bridges the type gap.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createClient = createServerClient as any;

export async function supabaseServer(): Promise<SupabaseClient> {
  const cookieStore = await cookies();
  return createClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: Array<{ name: string; value: string; options?: Record<string, unknown> }>) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options as Record<string, unknown> | undefined),
          );
        } catch {
          // Server Component — middleware refreshes sessions.
        }
      },
    },
  });
}

export function supabaseMiddlewareClient(req: NextRequest): SupabaseClient {
  return createClient(url, anonKey, {
    cookies: {
      getAll() {
        return req.cookies.getAll();
      },
      setAll(cookiesToSet: Array<{ name: string; value: string }>) {
        cookiesToSet.forEach(({ name, value }) => req.cookies.set(name, value));
      },
    },
  });
}

export function supabaseService(): SupabaseClient {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, serviceKey, {
    cookies: {
      getAll: () => [],
      setAll: () => {},
    },
  });
}
