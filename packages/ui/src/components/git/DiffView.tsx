import React, { useMemo } from "react";
import { cn } from "../../lib/cn";
import { parseUnifiedDiff, type DiffRow } from "./git-diff";

/**
 * Renders a unified diff in the GitHub-Desktop style: a scrollable monospace
 * area with two right-aligned line-number gutters (old, new) and +/- coloring.
 * The PTY-free counterpart to the file Editor — purely presentational.
 */
export const DiffView: React.FC<{
  diff: string;
  binary?: boolean;
  loading?: boolean;
  emptyLabel?: string;
}> = ({ diff, binary, loading, emptyLabel }) => {
  const parsed = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const isBinary = binary || parsed.binary;

  if (loading) {
    return <Centered>Loading diff…</Centered>;
  }
  if (isBinary) {
    return <Centered>Binary file not shown</Centered>;
  }
  if (parsed.hunks.length === 0) {
    return <Centered>{emptyLabel ?? "No changes"}</Centered>;
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-neutral-950 font-mono text-xs leading-5">
      {parsed.hunks.map((hunk, hunkIndex) =>
        hunk.rows.map((row, rowIndex) => (
          <DiffLine key={`${hunkIndex}:${rowIndex}`} row={row} />
        ))
      )}
    </div>
  );
};

const DiffLine: React.FC<{ row: DiffRow }> = ({ row }) => {
  if (row.type === "hunk") {
    return (
      <div className="flex bg-neutral-900 text-neutral-500">
        <span className="w-20 shrink-0 select-none border-r border-neutral-800" />
        <span className="whitespace-pre px-2">{row.text}</span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex",
        row.type === "add" && "bg-green-950/40 text-green-300",
        row.type === "del" && "bg-red-950/40 text-red-300",
        row.type === "context" && "text-neutral-300"
      )}
    >
      <span className="flex shrink-0 select-none border-r border-neutral-800 text-neutral-600">
        <span className="w-10 px-1 text-right tabular-nums">{row.oldNo ?? ""}</span>
        <span className="w-10 px-1 text-right tabular-nums">{row.newNo ?? ""}</span>
      </span>
      <span className="w-4 shrink-0 select-none text-center">
        {row.type === "add" ? "+" : row.type === "del" ? "-" : ""}
      </span>
      <span className="whitespace-pre pr-2">{row.text}</span>
    </div>
  );
};

const Centered: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex flex-1 items-center justify-center text-sm text-neutral-600">{children}</div>
);
