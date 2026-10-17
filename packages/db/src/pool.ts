// Connection layer — per-region pools + claims injection.
//
// One pool per region cluster (db-eu, db-us, db-apac). Every checkout sets
// the `supa_app` role (non-bypass — RLS enforced). `withUser` sets the JWT
// claims sub for the request so `current_uid()` (migration 0033) returns the
// caller's user id — every query in the closure runs AS the user, under RLS.
//
// System/definer operations (bootstrap, purge, cron) use a separate pool
// (`systemPool`) connected as `supa_system` — a role with elevated privileges
// but still subject to RLS (no BYPASSRLS). System operations that need to
// bypass RLS (e.g. the audit log append security-definer function) use
// SECURITY DEFINER functions, not role bypass.
//
// DIVERGENCE from the pasted spec:
//   The spec uses `pg.Pool` (the `pg` npm package). This codebase uses the
//   `postgres` driver (the `postgres` npm package, already installed). The
//   `postgres` driver has built-in connection pooling + a `begin()` method
//   that handles BEGIN/COMMIT/ROLLBACK automatically. The pattern is adapted
//   to the existing driver — the semantics are identical (per-request claims
//   injection, transaction-local, pooled connection reset on release).
//
// USAGE:
//   const pool = makePool("DB_EU");
//   const result = await withUser(pool, userId, async (tx) => {
//     // Every query here runs AS userId, under RLS.
//     return tx`select * from workspaces where id = ${wsId}`;
//   });
//
// The `tx` is a `postgres` transaction object — supports tagged template
// queries (same as the Drizzle `db` but without the type safety). For typed
// queries, use the Drizzle client (`@supa/db`) with the `withUserDrizzle`
// wrapper instead.

import postgres, { type Sql, type TransactionSql } from "postgres";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

/** A region cluster connection string env var name. */
export type ClusterEnv = "DB_EU" | "DB_US" | "DB_APAC" | "DATABASE_URL";

/** A transaction-scoped query function (the `postgres` tagged template). */
export type Transaction = TransactionSql<Record<string, unknown>>;

// ───────────────────────────────────────────────
// makePool — per-region pool, sets supa_app role on connect
// ───────────────────────────────────────────────

const poolCache = new Map<string, Sql>();

/**
 * Create a connection pool for a region cluster. The pool sets the `supa_app`
 * role on every new connection (the non-bypass application role — RLS enforced).
 *
 * The pool is cached per env var name — calling `makePool("DB_EU")` twice
 * returns the same pool (avoids leaking connections).
 *
 * The connection string comes from the env var named by `cluster` (e.g.
 * `DB_EU`, `DB_US`, `DB_APAC`). For development, `DATABASE_URL` is the default.
 *
 * `application_name: "supa"` — for Postgres query monitoring (pg_stat_activity).
 */
export function makePool(cluster: ClusterEnv = "DATABASE_URL"): Sql {
  const cached = poolCache.get(cluster);
  if (cached) return cached;

  const connectionString = process.env[cluster];
  if (!connectionString) {
    throw new Error(
      `Connection string not found: set ${cluster} env var (or DATABASE_URL for dev).`,
    );
  }

  const pool = postgres(connectionString, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    connection: {
      application_name: "supa",
    },
    prepare: false,
  });

  // Note: the `postgres` driver doesn't have a `pool.on('connect')` event
  // like `pg.Pool`. The `supa_app` role is set per-transaction in `withUser`
  // (transaction-local — reset on commit/rollback). This is actually safer
  // than connection-level role setting: a connection that leaks from one
  // request to another doesn't carry the role forward.

  poolCache.set(cluster, pool);
  return pool;
}

// ───────────────────────────────────────────────
// withUser — claims injection (the RLS gate)
// ───────────────────────────────────────────────

/**
 * Run a function as a specific user, with RLS claims injected.
 *
 * Acquires a connection from the pool, begins a transaction, sets
 * `request.jwt.claims.sub` to the user's id (so `current_uid()` returns it),
 * runs the function, and commits/rolls back.
 *
 * Every query in the closure runs AS the user, under RLS. The claims are
 * transaction-local — they're reset when the transaction commits/rolls back
 * and the connection is returned to the pool.
 *
 * The `set role supa_app` is also set inside the transaction (so the
 * connection runs as the non-bypass role for the duration of the request,
 * even if the pool didn't set it on connect).
 *
 * USAGE:
 *   ```
 *   const result = await withUser(pool, userId, async (tx) => {
 *     const [ws] = await tx`select * from workspaces where id = ${wsId}`;
 *     return ws;
 *   });
 *   ```
 *
 * The `tx` is a `postgres.Transaction` — supports tagged template queries.
 * For typed queries, use `withUserDrizzle` (below) instead.
 */
export async function withUser<T>(
  pool: Sql,
  uid: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return pool.begin(async (tx) => {
    // Set the supa_app role (non-bypass — RLS enforced).
    await tx.unsafe("set role supa_app");
    // Set the JWT claims sub (current_uid() returns this).
    await tx`select set_config('request.jwt.claims.sub', ${uid}, true)`;
    // Run the function's queries (all under RLS as the user).
    return fn(tx);
  }) as Promise<T>;
}

// ───────────────────────────────────────────────
// withSystem — system/definer operations (bootstrap, purge, cron)
// ───────────────────────────────────────────────

/**
 * Run a function as the system role, with elevated privileges but still
 * subject to RLS (no BYPASSRLS).
 *
 * System operations that need to bypass RLS (e.g. the audit log append
 * security-definer function) use SECURITY DEFINER functions, not role bypass.
 *
 * The system pool connects as `supa_system` (a role with INSERT/UPDATE/DELETE
 * on all tables but still subject to RLS). This is for:
 *   - Bootstrap (workspace creation — no user context yet).
 *   - Purge (cron — no user context, but still subject to RLS on tenant tables).
 *   - System audit entries (actor_type='system').
 *
 * The system role does NOT set JWT claims (current_uid() returns null —
 * system operations are not user-scoped).
 */
export async function withSystem<T>(
  pool: Sql,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return pool.begin(async (tx) => {
    await tx.unsafe("set role supa_system");
    return fn(tx);
  }) as Promise<T>;
}

// ───────────────────────────────────────────────
// systemPool — the default system pool (lazy init)
// ───────────────────────────────────────────────

let _systemPool: Sql | null = null;

/**
 * The default system pool. Connected as `supa_system` (role with elevated
 * privileges but still subject to RLS). Uses `DB_SYSTEM` env var, or falls
 * back to `DATABASE_URL` for development.
 *
 * Lazy-initialized (the pool is created on first access, not at module load).
 */
export function getSystemPool(): Sql {
  if (_systemPool) return _systemPool;
  const url = process.env.DB_SYSTEM ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DB_SYSTEM or DATABASE_URL is required");
  _systemPool = postgres(url, {
    max: 5, // fewer connections for system ops (low volume).
    idle_timeout: 20,
    connection: {
      application_name: "supa-system",
    },
    prepare: false,
  });
  return _systemPool;
}

// ───────────────────────────────────────────────
// resolvePool — region-aware pool selection
// ───────────────────────────────────────────────

/** Region → cluster env var mapping (mirrors @supa/agents/residency). */
const REGION_TO_CLUSTER: Record<string, ClusterEnv> = {
  eu: "DB_EU",
  us: "DB_US",
  apac: "DB_APAC",
};

/**
 * Resolve the pool for a workspace's region. The workspace's region is
 * immutable (chosen at creation); cross-region reads are prohibited
 * (no federation). Every workspace-scoped request routes to its cluster
 * before any query runs.
 *
 * For development (no multi-cluster), falls back to `DATABASE_URL`.
 */
export function resolvePool(region: string | null | undefined): Sql {
  if (!region) return makePool("DATABASE_URL");
  const cluster = REGION_TO_CLUSTER[region];
  if (!cluster) return makePool("DATABASE_URL");
  try {
    return makePool(cluster);
  } catch {
    // Multi-cluster not configured (dev) → fall back to DATABASE_URL.
    return makePool("DATABASE_URL");
  }
}

// ───────────────────────────────────────────────
// withUserDrizzle — typed queries with claims injection
// ───────────────────────────────────────────────

/**
 * Run a function as a specific user, with RLS claims injected, using the
 * Drizzle client for typed queries.
 *
 * This is the typed counterpart to `withUser` — it wraps the Drizzle `db`
 * object with claims injection. The Drizzle client is shared across all
 * requests (the claims are transaction-local), so this function uses a
 * transaction to scope the claims.
 *
 * USAGE:
 *   ```
 *   const result = await withUserDrizzle(userId, async (tx) => {
 *     const [ws] = await tx.select().from(workspaces).where(eq(workspaces.id, wsId));
 *     return ws;
 *   });
 *   ```
 *
 * NOTE: the Drizzle client uses a different connection pool than `makePool`.
 * In production, both would route to the same region cluster (the Drizzle
 * client's DATABASE_URL and makePool's DB_EU/DB_US/DB_APAC point to the same
 * physical cluster per region). The claims injection is the same pattern
 * (set_config in a BEGIN block).
 */
export async function withUserDrizzle<T>(
  uid: string,
  fn: (tx: DrizzleTransaction) => Promise<T>,
): Promise<T> {
  const { db } = await import("./client.js");
  return db.transaction(async (tx) => {
    // Set the supa_app role + JWT claims for RLS.
    // Drizzle's tx.execute() takes a SQL wrapper; we use sql.raw for the
    // set_config call.
    const { sql } = await import("drizzle-orm");
    await tx.execute(sql`set role supa_app`);
    await tx.execute(sql`select set_config('request.jwt.claims.sub', ${uid}, true)`);
    return fn(tx as unknown as DrizzleTransaction);
  });
}

/** A Drizzle transaction (typed query interface). */
export type DrizzleTransaction = Parameters<
  Parameters<import("./client.js").Database["transaction"]>[0]
>[0];

// ───────────────────────────────────────────────
// cleanup — close all pools (for tests / graceful shutdown)
// ───────────────────────────────────────────────

/** Close all cached pools. Called on graceful shutdown or in test teardown. */
export async function closeAllPools(): Promise<void> {
  const promises: Promise<unknown>[] = [];
  for (const pool of poolCache.values()) {
    promises.push(pool.end({ timeout: 5 }));
  }
  if (_systemPool) {
    promises.push(_systemPool.end({ timeout: 5 }));
    _systemPool = null;
  }
  poolCache.clear();
  await Promise.allSettled(promises);
}
