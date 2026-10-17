// GET /api/supa-os/catalog/stacks
//
// Returns the available stack configurations (Next.js 15 + Supabase, Flutter
// + Firebase) — the catalog the kernel picks from when scaffolding a build.
//
// Auth: admin session (read_only).

import { adminOnly, okResponse } from "@/lib/api/route-helpers";
import { TARGET_STACK as NEXTJS_STACK } from "@/lib/supa-os/nextjs-supabase-engine";
import { TARGET_STACK as FLUTTER_STACK } from "@/lib/supa-os/flutter-firebase-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminOnly("read_only", async (req, ctx) => {
  return okResponse({
    stacks: [
      { id: "nextjs_supabase", label: "Next.js 15 + Supabase", stack: NEXTJS_STACK },
      { id: "flutter_firebase", label: "Flutter + Firebase", stack: FLUTTER_STACK },
    ],
  });
});
