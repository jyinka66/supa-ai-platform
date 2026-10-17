/**
 * PostgresNumberAllocator — the real DB implementation of the
 * NumberAllocator contract from @supa/invoicing/numbering.
 *
 * Runs the atomic INSERT ... ON CONFLICT ... RETURNING statement
 * documented in the numbering module. Collisions impossible by
 * construction (DB serializes the upsert); gaps allowed (a rolled-
 * back tx leaves a gap — honest).
 */

import { db } from "@supa/db";
import { sql } from "drizzle-orm";
import type { NumberAllocator, SequenceKey } from "@supa/invoicing/numbering";

export class PostgresNumberAllocator implements NumberAllocator {
  async allocate(key: SequenceKey): Promise<number> {
    const result = await db.execute(sql`
      INSERT INTO invoice_sequences (workspace_id, profile_id, kind, next)
      VALUES (${key.wsId}, ${key.profileId}, ${key.kind}, 2)
      ON CONFLICT (workspace_id, profile_id, kind)
      DO UPDATE SET next = invoice_sequences.next + 1
      RETURNING next - 1 AS allocated;
    `);
    // postgres-js returns a RowList (array-like) directly, not { rows: ... }.
    const rows = result as unknown as Array<{ allocated: bigint | number }>;
    const row = rows[0];
    if (!row) {
      throw new Error(`allocate failed for key: ${JSON.stringify(key)}`);
    }
    return Number(row.allocated);
  }

  async peek(key: SequenceKey): Promise<number> {
    const result = await db.execute(sql`
      SELECT COALESCE(MAX(next), 1) AS next
      FROM invoice_sequences
      WHERE workspace_id = ${key.wsId}
        AND profile_id = ${key.profileId}
        AND kind = ${key.kind};
    `);
    const rows = result as unknown as Array<{ next: bigint | number }>;
    return Number(rows[0]?.next ?? 1);
  }
}
