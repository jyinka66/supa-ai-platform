import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

type DatabaseEnvironment = Record<string, string | undefined>;

function getProjectRef(env: DatabaseEnvironment): string | undefined {
  const configured = env.SUPABASE_PROJECT_REF?.trim();
  if (configured && /^[a-z0-9-]{16,32}$/i.test(configured)) return configured;

  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL ?? env.SUPABASE_URL;
  if (!supabaseUrl) return undefined;

  try {
    const hostname = new URL(supabaseUrl).hostname;
    return hostname.match(/^([a-z0-9-]{16,32})\.supabase\.co$/i)?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Resolve DATABASE_URL without logging it. For Vercel/serverless, the optional
 * SUPABASE_DB_POOLER_HOST overrides only the endpoint while the existing secret
 * supplies the password. Copy the hostname from Supabase Dashboard > Connect >
 * Transaction pooler; it cannot safely be derived from the project's region.
 */
export function resolveDatabaseUrl(env: DatabaseEnvironment = process.env): string {
  const configuredUrl = env.DATABASE_URL?.trim();
  if (!configuredUrl) throw new Error("DATABASE_URL is required");

  let url: URL;
  try {
    url = new URL(configuredUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the postgres or postgresql protocol");
  }

  const poolerHost = env.SUPABASE_DB_POOLER_HOST?.trim();
  if (!poolerHost) return configuredUrl;

  // A hostname only is accepted: don't overwrite or log credentials by mistake.
  if (
    poolerHost.includes("://") ||
    /[/?#@\s]/.test(poolerHost) ||
    !/^[a-z0-9.-]+$/i.test(poolerHost) ||
    !poolerHost.toLowerCase().endsWith(".pooler.supabase.com")
  ) {
    throw new Error("SUPABASE_DB_POOLER_HOST must be the hostname copied from Supabase Connect");
  }

  const port = env.SUPABASE_DB_POOLER_PORT?.trim() || "6543";
  if (port !== "5432" && port !== "6543") {
    throw new Error("SUPABASE_DB_POOLER_PORT must be 5432 (session) or 6543 (transaction)");
  }
  const projectRef = getProjectRef(env);
  if (!projectRef) {
    throw new Error("Set SUPABASE_PROJECT_REF or NEXT_PUBLIC_SUPABASE_URL to determine the shared-pooler username");
  }

  url.hostname = poolerHost;
  url.port = port;
  url.username = "postgres." + projectRef;
  // Existing password, database path, and query options remain unchanged.
  return url.toString();
}

/**
 * Create the database connection lazily because Next.js imports route modules
 * during build. In serverless environments keep one client connection per warm
 * instance and use TLS for Supabase endpoints.
 */
function createDatabase() {
  const connectionUrl = resolveDatabaseUrl();
  const parsed = new URL(connectionUrl);
  const usesSupabaseEndpoint =
    parsed.hostname.endsWith(".supabase.co") ||
    parsed.hostname.endsWith(".pooler.supabase.com");

  const client = postgres(connectionUrl, {
    max: process.env.VERCEL ? 1 : 10,
    prepare: false,
    ssl: usesSupabaseEndpoint ? "require" : false,
    connect_timeout: 10,
    idle_timeout: 20,
  });
  return drizzle(client, { schema });
}

type DatabaseClient = ReturnType<typeof createDatabase>;
let instance: DatabaseClient | undefined;

function getDatabase(): DatabaseClient {
  instance ??= createDatabase();
  return instance;
}

/**
 * Preserve the exported Drizzle API and inferred types while deferring the
 * environment check and pool construction until a request first queries DB.
 */
export const db = new Proxy({} as DatabaseClient, {
  get(_target, property) {
    const database = getDatabase();
    const value: unknown = Reflect.get(database, property, database);
    return typeof value === "function" ? value.bind(database) : value;
  },
});

export type Database = DatabaseClient;
