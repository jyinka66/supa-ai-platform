// Test setup — sets a dummy DATABASE_URL so that modules which transitively
// import @supa/db (budget/ledger, killswitch, runs/executor) don't crash at
// module-load time. The postgres() client is lazy — it won't connect until
// a query is actually run. Integration tests that need a real DB set
// RUN_INTEGRATION=1 and must have a working DATABASE_URL pointing at a
// Postgres instance with migration 0026 applied.
//
// This file is loaded before any test module (per vitest.config.ts setupFiles).

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgres://dummy:dummy@localhost:5432/dummy";
}
