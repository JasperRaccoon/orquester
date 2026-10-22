import React, { useMemo } from "react";
import { ChevronRight, ChevronsDownUp, ChevronsUpDown } from "lucide-react";

import { cn } from "../../lib/cn";
import { ChangeKindSplit } from "./ChangeKindSplit";
import { DiffHunks } from "./DiffView";
import {
  collapsedByDefault,
  diffFileBadges,
  diffFileEmptyLabel,
  diffFileKey,
  splitTruncationMarker,
  type DiffFileBadgeTone
} from "./diff-files";
import { parseDiffFiles, type DiffFile } from "./git-diff";

const BADGE_TONE: Record<DiffFileBadgeTone, string> = {
  added: "text-[color:var(--git-added)]",
  deleted: "text-[color:var(--git-deleted)]",
  renamed: "text-[color:var(--git-renamed)]",
  neutral: "text-neutral-400"
};

const dirOf = (path: string): string => {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index + 1);
};
const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/**
 * A multi-file patch (a turn's diff) rendered one section per file: a sticky
 * header naming the file — old → new for a rename — with its markers and +/-
 * counts, which collapses the section, then that file's hunks. A summary bar
 * on top carries the file count, the totals, the code/tests/docs split and
 * the caller's `controls`.
 *
 * Binary files, mode-only changes and pure renames get a one-line body of
 * their own, so one binary file never blanks the files beside it.
 */
export const DiffFilesView: React.FC<{
  diff: string;
  loading?: boolean;
  emptyLabel?: string;
  /** Extra controls at the end of the summary bar (e.g. a whitespace toggle). */
  controls?: React.ReactNode;
}> = ({ diff, loading, emptyLabel, controls }) => {
  const { text, truncated } = useMemo(() => splitTruncationMarker(diff), [diff]);
  const files = useMemo(() => parseDiffFiles(text), [text]);
  const totals = useMemo(
    () =>
      files.reduce(
        (sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }),
        { additions: 0, deletions: 0 }
      ),
    [files]
  );

  // Per-section open/closed overrides, dropped whenever the patch changes so a
  // new turn (or a whitespace re-read) starts from each file's default.
  const [overrides, setOverrides] = React.useState<{ files: DiffFile[]; open: Record<string, boolean> }>(() => ({
    files,
    open: {}
  }));
  const open = overrides.files === files ? overrides.open : {};
  const isOpen = (file: DiffFile, index: number): boolean =>
    open[diffFileKey(file, index)] ?? !collapsedByDefault(file);
  const anyOpen = files.some((file, index) => isOpen(file, index));
  const toggle = (file: DiffFile, index: number): void => {
    const key = diffFileKey(file, index);
    const next = !isOpen(file, index);
    setOverrides({ files, open: { ...open, [key]: next } });
  };
  const setAll = (value: boolean): void => {
    setOverrides({ files, open: Object.fromEntries(files.map((file, index) => [diffFileKey(file, index), value])) });
  };

  const showBody = !loading && files.length > 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-neutral-800 px-3 py-1.5 text-xs text-neutral-300">
        {showBody ? (
          <>
            <span>
              {files.length} changed file{files.length === 1 ? "" : "s"}
            </span>
            <span className="font-mono text-[10px] tabular-nums">
              <span className="text-[color:var(--diff-add-fg)]">+{totals.additions}</span>{" "}
              <span className="text-[color:var(--diff-del-fg)]">−{totals.deletions}</span>
            </span>
            <ChangeKindSplit files={files} />
          </>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {controls}
          {showBody && files.length > 1 ? (
            <button
              type="button"
              onClick={() => setAll(!anyOpen)}
              aria-label={anyOpen ? "Collapse all files" : "Expand all files"}
              title={anyOpen ? "Collapse all files" : "Expand all files"}
              className="flex h-6 w-6 items-center justify-center rounded text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
            >
              {anyOpen ? <ChevronsDownUp size={13} aria-hidden /> : <ChevronsUpDown size={13} aria-hidden />}
            </button>
          ) : null}
        </span>
      </div>
      {loading ? (
        <Centered>Loading diff…</Centered>
      ) : files.length === 0 ? (
        <Centered>{truncated ? "The diff was too large to show." : (emptyLabel ?? "No changes")}</Centered>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto bg-neutral-950 font-mono text-xs leading-5">
          {files.map((file, index) => (
            <DiffFileSection
              key={diffFileKey(file, index)}
              file={file}
              open={isOpen(file, index)}
              onToggle={() => toggle(file, index)}
            />
          ))}
          {truncated ? (
            <p className="px-3 py-2 font-sans text-xs text-neutral-500">
              The diff was cut at its size limit; later changes are not shown.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
};

const DiffFileSection: React.FC<{ file: DiffFile; open: boolean; onToggle: () => void }> = ({
  file,
  open,
  onToggle
}) => {
  const moved = (file.change === "renamed" || file.change === "copied") && file.oldPath !== null;
  const title = moved ? `${file.oldPath} → ${file.path}` : file.path;
  const badges = diffFileBadges(file);
  const dir = dirOf(file.path);
  return (
    <section aria-label={title} className="border-b border-neutral-800 last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        title={title}
        className="sticky top-0 z-10 flex w-full min-w-0 items-center gap-2 border-b border-neutral-800 bg-neutral-900 px-2 py-1 text-left font-sans hover:bg-neutral-800 focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-500"
      >
        <ChevronRight
          size={13}
          aria-hidden
          className={cn("shrink-0 text-neutral-500 transition-transform", open && "rotate-90")}
        />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          {moved ? (
            <>
              <span className="text-neutral-500">{file.oldPath}</span>
              <span className="text-neutral-500"> → </span>
            </>
          ) : null}
          {dir ? <span className="text-neutral-500">{dir}</span> : null}
          <span className="text-neutral-200">{baseName(file.path)}</span>
        </span>
        {badges.map((badge) => (
          <span
            key={badge.label}
            className={cn(
              "shrink-0 rounded border border-neutral-700 px-1 text-[10px] leading-4",
              BADGE_TONE[badge.tone]
            )}
          >
            {badge.label}
          </span>
        ))}
        <span className="shrink-0 font-mono text-[10px] tabular-nums">
          <span className="text-[color:var(--diff-add-fg)]">+{file.additions}</span>{" "}
          <span className="text-[color:var(--diff-del-fg)]">−{file.deletions}</span>
        </span>
      </button>
      {open ? (
        file.hunks.length > 0 ? (
          <DiffHunks hunks={file.hunks} />
        ) : (
          <p className="px-3 py-2 font-sans text-xs italic text-neutral-600">{diffFileEmptyLabel(file)}</p>
        )
      ) : null}
    </section>
  );
};

const Centered: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex flex-1 items-center justify-center px-4 py-6 text-sm text-neutral-600">{children}</div>
);
