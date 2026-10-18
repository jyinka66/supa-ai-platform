import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * Create the database connection on first use rather than when this module is
 * imported. Next.js imports route modules during "next build" to collect route
 * metadata; requiring a production DATABASE_URL at module scope makes an
 * otherwise valid build fail before a request is handled.
 *
 * DATABASE_URL is still mandatory when application code first queries the DB.
 * Configure it in the deployment environment; lazy initialization is not a
 * replacement for a real database connection.
 */
function createDatabase() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required");
  }

  const client = postgres(url, { max: 10, prepare: false });
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
 * environment check and pool construction until the first database call.
 */
export const db = new Proxy({} as DatabaseClient, {
  get(_target, property) {
    const database = getDatabase();
    const value: unknown = Reflect.get(database, property, database);

    // Drizzle methods rely on their instance as `this`.
    return typeof value === "function" ? value.bind(database) : value;
  },
});

export type Database = DatabaseClient;
