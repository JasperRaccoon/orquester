/**
 * `git diff --numstat -z` → the turn's changed-file list (spec §5.4).
 *
 * Ported from T3 Code (MIT): apps/server/src/checkpointing/Diffs.ts
 */

import type { CheckpointFile } from "@orquester/api/agent-chat";

/**
 * Reads git's NUL-delimited numstat output without decoding display paths.
 *
 * `-z` makes every record `<adds>\t<dels>\t<path>\0`, except a rename or copy,
 * which writes an empty path and then two more records — the source and the
 * destination. A binary file reports `-` for both counts, which is recorded as
 * zero rather than dropped: the file still changed.
 */
export function parseTurnDiffFilesFromNumstat(numstat: string): CheckpointFile[] {
  const records = numstat.split("\0");
  const files: CheckpointFile[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    const counts = /^(\d+|-)\t(\d+|-)\t/.exec(record);
    if (!counts) {
      continue;
    }

    let filePath = record.slice(counts[0].length);
    if (filePath.length === 0) {
      // Renames and copies use two more records: the source and the
      // destination. The destination is what the turn produced.
      filePath = records[index + 2] ?? "";
      index += 2;
    }
    if (filePath.length === 0) {
      continue;
    }

    files.push({
      path: filePath,
      additions: counts[1] === "-" ? 0 : Number(counts[1]),
      deletions: counts[2] === "-" ? 0 : Number(counts[2])
    });
  }

  return files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}
