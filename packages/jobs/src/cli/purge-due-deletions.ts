import { purgeDueDeletions } from "../purge-due-deletions";

/**
 * CLI entry point — invokable via `pnpm --filter @supa/jobs purge:deletions`.
 * Designed to run on a cron schedule (Vercel Cron, Railway, or k8s CronJob).
 *
 * Exit codes:
 *   0 — all due purges succeeded (or no work to do)
 *   1 — at least one purge failed (see logs for which user)
 */
async function main() {
  const results = await purgeDueDeletions();
  const failed = results.filter((r) => !r.purged);
  if (failed.length > 0) {
    console.error(
      JSON.stringify({
        event: "purge_cli_failed",
        failed_count: failed.length,
        failed_user_ids: failed.map((r) => r.userId),
      }),
    );
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ event: "purge_cli_crash", error: String(err) }));
  process.exit(1);
});
