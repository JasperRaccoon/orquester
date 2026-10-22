/**
 * The change-kind split's presentation logic (no React): which kinds a set of
 * changed files touches, how each reads, and when the split is worth showing.
 * Shared by the turn-diff header, the chat's changed-files card and the Git
 * tab, so the three agree on wording and on when they stay quiet.
 */

import {
  CHANGED_FILE_KINDS,
  summarizeChangedFileKinds,
  type ChangedFileKind
} from "@orquester/api";

// Adapted from T3 Code (MIT): apps/web/src/components/pullRequest/PullRequestChangeBreakdownStat.tsx
export const CHANGE_KIND_LABELS: Record<ChangedFileKind, string> = {
  code: "Code",
  tests: "Tests",
  mocks: "Mocks",
  generated: "Generated",
  docs: "Docs"
};

export interface ChangeKindRow {
  kind: ChangedFileKind;
  label: string;
  files: number;
  additions: number;
  deletions: number;
}

/** The kinds `files` touch, in display order; kinds with no file are left out. */
export function changeKindRows(
  files: readonly { path: string; additions?: number | null; deletions?: number | null }[]
): ChangeKindRow[] {
  const breakdown = summarizeChangedFileKinds(files);
  return CHANGED_FILE_KINDS.filter((kind) => breakdown[kind].files > 0).map((kind) => ({
    kind,
    label: CHANGE_KIND_LABELS[kind],
    ...breakdown[kind]
  }));
}

/**
 * Whether the split says anything the plain total does not. A change that is
 * all code would only repeat its total under a "Code" label; a change that is
 * all tests or all docs is worth naming, and any mix is the point.
 */
export function shouldShowChangeKindSplit(rows: readonly ChangeKindRow[]): boolean {
  return rows.length > 1 || (rows.length === 1 && rows[0]!.kind !== "code");
}

function fileCount(files: number): string {
  return `${files} file${files === 1 ? "" : "s"}`;
}

/** One kind in words, for a tooltip or a screen reader: "Tests: 2 files, +30 −4". */
export function changeKindDescription(row: ChangeKindRow, withLines: boolean): string {
  const lines = withLines && (row.additions > 0 || row.deletions > 0) ? `, +${row.additions} −${row.deletions}` : "";
  return `${row.label}: ${fileCount(row.files)}${lines}`;
}

/** The whole split in words, one kind per line. */
export function changeKindTitle(rows: readonly ChangeKindRow[], withLines: boolean): string {
  return rows.map((row) => changeKindDescription(row, withLines)).join("\n");
}
