import { purgeExpiredTrash } from "../purge-expired-trash";

/**
 * CLI entry point — invokable via `pnpm --filter @supa/jobs purge:trash`.
 *
 * Exit codes:
 *   0 — purge succeeded (or no work to do)
 *   1 — purge failed (see logs)
 */
async function main() {
  const result = await purgeExpiredTrash();
  const failed = result.fileErrors;
  if (failed > 0) {
    console.error(
      JSON.stringify({
        event: "purge_trash_cli_partial",
        purged: result.purgedCount,
        file_errors: failed,
      }),
    );
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ event: "purge_trash_cli_crash", error: String(err) }));
  process.exit(1);
});
