import React from "react";

import { cn } from "../../lib/cn";
import { changeKindRows, changeKindTitle, shouldShowChangeKindSplit } from "./change-kinds";

/**
 * A change's +/- split into code, tests, mocks, generated files and docs, as a
 * compact inline row: "Code +12 −3 · Tests +40". `mode="files"` counts files
 * instead, for lists that know paths but not line counts (the Git tab's
 * working tree). Renders nothing when the split would only repeat the total.
 */
export function ChangeKindSplit({
  files,
  mode = "lines",
  className
}: {
  files: readonly { path: string; additions?: number | null; deletions?: number | null }[];
  mode?: "lines" | "files";
  className?: string;
}): React.ReactElement | null {
  const rows = React.useMemo(() => changeKindRows(files), [files]);
  if (!shouldShowChangeKindSplit(rows)) return null;
  const withLines = mode === "lines";
  const title = changeKindTitle(rows, withLines);
  return (
    <span
      role="note"
      aria-label={title.replaceAll("\n", "; ")}
      title={title}
      className={cn("inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] font-normal", className)}
    >
      {rows.map((row) => (
        <span key={row.kind} aria-hidden className="inline-flex items-center gap-1 whitespace-nowrap">
          <span className="text-neutral-500">{row.label}</span>
          {withLines && (row.additions > 0 || row.deletions > 0) ? (
            <span className="font-mono tabular-nums">
              {row.additions > 0 ? <span className="text-[color:var(--diff-add-fg)]">+{row.additions}</span> : null}
              {row.additions > 0 && row.deletions > 0 ? " " : null}
              {row.deletions > 0 ? <span className="text-[color:var(--diff-del-fg)]">−{row.deletions}</span> : null}
            </span>
          ) : (
            // Files mode, or a kind with no line counts (binary files, a pure rename).
            <span className="font-mono tabular-nums text-neutral-400">
              {withLines ? `${row.files} file${row.files === 1 ? "" : "s"}` : row.files}
            </span>
          )}
        </span>
      ))}
    </span>
  );
}
