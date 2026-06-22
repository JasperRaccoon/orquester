/**
 * Pure unified-diff parser (no React). Turns `git diff` / `git show` output
 * into hunks of rows with old/new line numbers, ready for `<DiffView>` to
 * render a GitHub-Desktop-style unified diff.
 */

export type DiffRowType = "hunk" | "add" | "del" | "context";

export interface DiffRow {
  type: DiffRowType;
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export interface DiffHunk {
  header: string;
  rows: DiffRow[];
}

export interface ParsedDiff {
  hunks: DiffHunk[];
  binary: boolean;
}

// File-header / meta lines that carry no content and are skipped outright.
const META_PREFIXES = [
  "diff --git",
  "index ",
  "--- ",
  "+++ ",
  "new file",
  "deleted file",
  "similarity",
  "rename "
];

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parse raw unified-diff text into hunks of rows. */
export function parseUnifiedDiff(diff: string): ParsedDiff {
  if (diff.includes("Binary files") || diff.includes("GIT binary patch")) {
    return { hunks: [], binary: true };
  }

  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const line of diff.split("\n")) {
    const hunkMatch = HUNK_HEADER.exec(line);
    if (hunkMatch) {
      oldNo = Number(hunkMatch[1]);
      newNo = Number(hunkMatch[2]);
      current = { header: line, rows: [{ type: "hunk", oldNo: null, newNo: null, text: line }] };
      hunks.push(current);
      continue;
    }

    if (!current) {
      // Still in the file header; drop meta lines and anything before the first hunk.
      continue;
    }

    if (line.startsWith("\\")) {
      // "\ No newline at end of file" — carries no content.
      continue;
    }
    if (META_PREFIXES.some((prefix) => line.startsWith(prefix))) {
      continue;
    }

    const marker = line[0];
    const text = line.slice(1);
    if (marker === "+") {
      current.rows.push({ type: "add", oldNo: null, newNo: newNo++, text });
    } else if (marker === "-") {
      current.rows.push({ type: "del", oldNo: oldNo++, newNo: null, text });
    } else {
      // Context line (leading space) — also catches a stray trailing empty line.
      current.rows.push({ type: "context", oldNo: oldNo++, newNo: newNo++, text });
    }
  }

  return { hunks, binary: false };
}
