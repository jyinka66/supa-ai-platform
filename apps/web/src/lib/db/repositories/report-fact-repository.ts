/**
 * ReportFactRepository — the real DB implementation.
 *
 * The engine is PURE: it takes facts as input and returns rows. This
 * repository is the ONLY layer that touches the DB — it fetches the
 * monetary_facts for a workspace + period and hands them to the
 * engine.
 *
 * Every number the engine renders is provenance-traced: tap-hold on
 * any figure → the underlying fact list. The owner never has to
 * trust a total — they can always open it. This repository's job is
 * to make sure the fact list is honest, complete, and tenancy-scoped.
 */

import { db } from "@supa/db";
import { monetaryFacts } from "@supa/db/schema";
import { eq, and, gte, lte } from "drizzle-orm";
import type {
  ReportFact,
  ReportPeriod,
  ReportFactRepository as IReportFactRepository,
} from "@supa/reports/engine";
import type { Rate } from "@supa/money/money";
import type { WorkspaceScope } from "@supa/workspace-core/workspace";

function rowToFact(row: typeof monetaryFacts.$inferSelect): ReportFact {
  return {
    id: row.id,
    wsId: row.workspaceId as any,
    nativeAmountMinor: row.nativeAmountMinor,
    nativeCurrency: row.nativeCurrency,
    recordedRate: (row.recordedRate as Rate | null) ?? null,
    asOf: row.asOf.getTime(),
    kind: row.kind as ReportFact["kind"],
    sourceId: row.sourceId,
  };
}

export class ReportFactRepositoryImpl implements IReportFactRepository {
  async fetchFacts(
    scope: WorkspaceScope,
    period: ReportPeriod,
  ): Promise<readonly ReportFact[]> {
    // Tenancy spine: workspaceId + period window. RLS is the second
    // gate; this WHERE clause is the first.
    const rows = await db
      .select()
      .from(monetaryFacts)
      .where(
        and(
          eq(monetaryFacts.workspaceId, scope.wsId as any),
          gte(monetaryFacts.asOf, new Date(period.from)),
          lte(monetaryFacts.asOf, new Date(period.to)),
        ),
      );
    return rows.map(rowToFact);
  }
}
