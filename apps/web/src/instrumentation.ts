/**
 * Next.js instrumentation hook — runs once on server start.
 *
 * Initializes OpenTelemetry tracing. If no OTEL endpoint is configured,
 * this is a no-op (the app still works; structured logs are the primary
 * observability surface).
 *
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register(): Promise<void> {
  // Only run on the server (not in the browser build).
  if (typeof window !== "undefined") return;

  // Dynamic import so the OTEL packages aren't bundled into the client.
  const { initTracing } = await import("./lib/observability/tracing");
  initTracing();
}
