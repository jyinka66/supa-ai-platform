import { db } from "@supa/db";
import { sql } from "drizzle-orm";
import { getMockFail, setMockFail, clearMockFail, listMockFailProviders } from "@/lib/test/mock-fail-state";
import type { Provider } from "@/lib/router/router";

/**
 * Dev harness utilities for local development.
 *
 * These functions wrap the in-memory mock-fail state (from
 * `@/lib/test/mock-fail-state`) with a DB-backed persistence layer so that:
 *   - Mock state survives server restarts in local dev
 *   - Multiple dev server instances can share mock state (rare but useful)
 *   - The dev harness UI can display current mock state
 *
 * The DB persistence is OPTIONAL — if the `dev_mock_failures` table doesn't
 * exist (e.g. fresh DB before migrations run), the functions fall back to
 * the in-memory state. This keeps the dev experience smooth even before
 * `pnpm db:migrate` has run.
 *
 * Production safety:
 *   - `shouldFail()` is a sync no-op when `NODE_ENV === 'production'`
 *   - `setMockFailure()` throws if called in production
 *   - The `/api/test/mock-fail` route is gated by `testGate()` which 404s in prod
 *
 * The `dev_mock_failures` table is created by migration 0005_dev_harness.sql.
 */

const isDev = process.env.NODE_ENV === "development";

interface MockFailureRow {
  provider: string;
  status: number | null;
}

/**
 * Sets (or clears) a mock failure for a provider.
 *
 * Writes to BOTH:
 *   1. The in-memory state (immediate effect — adapters check this)
 *   2. The DB `dev_mock_failures` table (persistence across restarts)
 *
 * Pass `null` as the status to clear the mock.
 */
export async function setMockFailure(
  provider: Provider,
  status: number | null,
): Promise<void> {
  if (!isDev) {
    throw new Error("setMockFailure is only available in development");
  }

  // Update in-memory state first — this is what the adapters actually check.
  if (status === null) {
    clearMockFail(provider);
  } else {
    setMockFail(provider, { status });
  }

  // Persist to DB (best-effort — table may not exist yet).
  try {
    if (status === null) {
      await db.execute(
        sql`DELETE FROM mock_failures WHERE provider = ${provider}`,
      );
    } else {
      await db.execute(
        sql`
          INSERT INTO mock_failures (provider, status, updated_at)
          VALUES (${provider}, ${status}, now())
          ON CONFLICT (provider)
          DO UPDATE SET status = EXCLUDED.status, updated_at = now()
        `,
      );
    }
  } catch (err) {
    // Table doesn't exist yet — fall back to in-memory only.
    console.warn(
      JSON.stringify({
        event: "dev_mock_failure_db_persist_skipped",
        provider,
        error: String(err),
      }),
    );
  }
}

/**
 * Returns the mock-fail status for a provider, or null if not mocked.
 *
 * Reads from in-memory state first (fast path). If the in-memory state is
 * empty AND we're in dev, tries the DB (in case the mock was set before a
 * server restart).
 *
 * Sync — the adapters call this at the top of `stream()` and can't await.
 * The DB read happens once on server boot via `loadMockFailuresFromDb()`.
 */
export function shouldFail(provider: Provider): number | null {
  if (!isDev) return null;
  const config = getMockFail(provider);
  return config?.status ?? null;
}

/**
 * Loads persisted mock failures from the DB into in-memory state.
 * Called once on server boot to restore mock state after a restart.
 *
 * Best-effort — if the table doesn't exist, silently no-ops.
 */
export async function loadMockFailuresFromDb(): Promise<void> {
  if (!isDev) return;
  try {
    const rows = await db.execute(
      sql`SELECT provider, status FROM mock_failures WHERE status IS NOT NULL`,
    );
    for (const row of rows as unknown as MockFailureRow[]) {
      if (row?.provider && typeof row.status === "number") {
        setMockFail(row.provider as Provider, { status: row.status });
      }
    }
  } catch {
    // Table doesn't exist — no-op.
  }
}

/**
 * Returns all currently-mocked providers + their statuses.
 * Used by the dev harness UI to display mock state.
 */
export function listMockFailures(): Array<{ provider: Provider; status: number }> {
  if (!isDev) return [];
  return listMockFailProviders().map((provider) => {
    const config = getMockFail(provider);
    return { provider, status: config?.status ?? 500 };
  });
}
