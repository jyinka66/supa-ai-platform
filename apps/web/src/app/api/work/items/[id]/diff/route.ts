import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@supa/db";
import { workItemVersions } from "@supa/db/schema";
import { eq, and } from "drizzle-orm";
import { requireUser } from "@/lib/auth/session";
import { guard } from "@/lib/ratelimit/guard";
import { problem, ok } from "@/lib/api/problem";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  from: z.coerce.number().int().min(1),
  to: z.coerce.number().int().min(1),
}).refine((d) => d.from !== d.to, {
  message: "from and to must be different versions",
});

interface DiffLine {
  type: "added" | "removed" | "unchanged";
  text: string;
  oldLineNum: number | null;
  newLineNum: number | null;
}

interface DiffResponse {
  fromVersion: number;
  toVersion: number;
  addedLines: number;
  removedLines: number;
  changedLines: number;
  diff: DiffLine[];
}

/**
 * GET /api/work/items/:id/diff?from=v1&to=v2
 *
 * Returns a line-by-line diff between two versions.
 *
 * Uses a simple LCS-based diff algorithm (no external dependency).
 * For large content (>10k lines), consider switching to a faster algorithm
 * (e.g. Myers diff via a native module).
 *
 * The diff is returned as an array of { type, text, oldLineNum, newLineNum }
 * entries — the client renders them as a unified diff view.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await guard(req, "default");
  if (denied) return denied;

  await requireUser();
  const { id } = await params;

  // Parse query params.
  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    from: url.searchParams.get("from"),
    to: url.searchParams.get("to"),
  });
  if (!parsed.success) {
    return problem(400, "invalid_params", parsed.error.issues[0]?.message);
  }
  const { from, to } = parsed.data;

  // Fetch both version snapshots.
  const [fromRows, toRows] = await Promise.all([
    db
      .select({ content: workItemVersions.content, title: workItemVersions.title })
      .from(workItemVersions)
      .where(
        and(
          eq(workItemVersions.itemId, id),
          eq(workItemVersions.version, from),
        ),
      )
      .limit(1),
    db
      .select({ content: workItemVersions.content, title: workItemVersions.title })
      .from(workItemVersions)
      .where(
        and(
          eq(workItemVersions.itemId, id),
          eq(workItemVersions.version, to),
        ),
      )
      .limit(1),
  ]);

  const fromSnapshot = fromRows[0];
  const toSnapshot = toRows[0];

  if (!fromSnapshot) {
    return problem(404, "from_version_not_found");
  }
  if (!toSnapshot) {
    return problem(404, "to_version_not_found");
  }

  // Compute the diff.
  const fromContent = fromSnapshot.content ?? "";
  const toContent = toSnapshot.content ?? "";

  const diff = computeDiff(fromContent, toContent);

  const addedLines = diff.filter((d) => d.type === "added").length;
  const removedLines = diff.filter((d) => d.type === "removed").length;
  const changedLines = addedLines + removedLines;

  const response: DiffResponse = {
    fromVersion: from,
    toVersion: to,
    addedLines,
    removedLines,
    changedLines,
    diff,
  };

  return ok(response);
}

/**
 * Simple line-based diff using LCS (Longest Common Subsequence).
 *
 * Returns an array of diff lines with type (added/removed/unchanged).
 * Each line includes old/new line numbers for the client to render
 * a side-by-side or unified diff view.
 *
 * Time complexity: O(n * m) where n, m are line counts.
 * Fine for typical content (<1000 lines); for larger, use a Myers diff.
 */
function computeDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const n = oldLines.length;
  const m = newLines.length;

  // Build LCS table.
  const lcs: number[][] = Array(n + 1)
    .fill(null)
    .map(() => Array(m + 1).fill(0));

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        lcs[i]![j] = (lcs[i - 1]![j - 1] ?? 0) + 1;
      } else {
        lcs[i]![j] = Math.max(lcs[i - 1]![j] ?? 0, lcs[i]![j - 1] ?? 0);
      }
    }
  }

  // Backtrack to build the diff.
  const result: DiffLine[] = [];
  let i = n;
  let j = m;
  let oldLineNum = n;
  let newLineNum = m;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({
        type: "unchanged",
        text: oldLines[i - 1]!,
        oldLineNum: oldLineNum,
        newLineNum: newLineNum,
      });
      i--;
      j--;
      oldLineNum--;
      newLineNum--;
    } else if (j > 0 && (i === 0 || lcs[i]![j - 1]! >= lcs[i - 1]![j]!)) {
      result.unshift({
        type: "added",
        text: newLines[j - 1]!,
        oldLineNum: null,
        newLineNum: newLineNum,
      });
      j--;
      newLineNum--;
    } else if (i > 0) {
      result.unshift({
        type: "removed",
        text: oldLines[i - 1]!,
        oldLineNum: oldLineNum,
        newLineNum: null,
      });
      i--;
      oldLineNum--;
    }
  }

  return result;
}
