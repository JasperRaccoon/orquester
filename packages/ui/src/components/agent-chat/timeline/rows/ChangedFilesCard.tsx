import React from "react";
import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  File as FileIcon,
  FileDiff,
  Folder,
  FolderClosed
} from "lucide-react";

import type { Checkpoint } from "@orquester/api/agent-chat";

import { cn } from "../../../../lib/cn";
import { ChangeKindSplit } from "../../../git/ChangeKindSplit";
import { ChatIconButton } from "../../primitives";
import { useTimelineRowContext } from "../context";
import {
  buildDiffTree,
  collectDirectoryPaths,
  hasNonZeroStat,
  summarizeDiffStats,
  type DiffStat,
  type DiffTreeNode
} from "../diff-tree";

function DiffStatLabel({ stat }: { stat: DiffStat }): React.ReactElement | null {
  if (!hasNonZeroStat(stat)) return null;
  return (
    <span className="ac-tabular ml-auto shrink-0 font-mono text-[10px]">
      {stat.additions > 0 ? (
        <span className="text-[color:var(--diff-add-fg)]">+{stat.additions}</span>
      ) : null}
      {stat.additions > 0 && stat.deletions > 0 ? " " : null}
      {stat.deletions > 0 ? (
        <span className="text-[color:var(--diff-del-fg)]">−{stat.deletions}</span>
      ) : null}
    </span>
  );
}

/**
 * The end-of-turn changed-files card (§7.3), fed by
 * `thread.turn-diff-completed`.
 *
 * It opens as the summary line alone ("N changed files · +a −b" and the
 * turn's split into code, tests, docs and generated files), so a finished turn
 * costs one line of scroll. Pressing the summary shows the file tree with its
 * folders collapsed; the expand-all button then opens every folder.
 *
 * `sticky top-2` on the header is the nice touch: scroll a long file list and
 * the summary stays.
 * *T3: `ChangedFilesTree.tsx:51-56, 183, 192-212`.*
 */
export const ChangedFilesCard = React.memo(function ChangedFilesCard({
  turnCount,
  files
}: {
  turnCount: number;
  files: Checkpoint["files"];
}): React.ReactElement {
  const ctx = useTimelineRowContext();
  const tree = React.useMemo(() => buildDiffTree(files), [files]);
  const summary = React.useMemo(() => summarizeDiffStats(files), [files]);
  const directoryPaths = React.useMemo(() => collectDirectoryPaths(tree), [tree]);
  const hasDirectories = directoryPaths.length > 0;

  const [listOpen, setListOpen] = React.useState(false);
  const [allExpanded, setAllExpanded] = React.useState(false);
  // The identity key resets per-directory overrides whenever the tree's shape
  // or the expand-all state changes, so a new turn never inherits stale toggles.
  const identity = `${allExpanded ? "expanded" : "collapsed"}\u0000${directoryPaths.join("\u0000")}`;
  const [overrides, setOverrides] = React.useState<{ key: string; value: Record<string, boolean> }>(() => ({
    key: identity,
    value: {}
  }));
  const expandedDirectories = overrides.key === identity ? overrides.value : {};

  const toggleDirectory = React.useCallback(
    (path: string) => {
      setOverrides((current) => {
        const next = current.key === identity ? current.value : {};
        return { key: identity, value: { ...next, [path]: !(next[path] ?? allExpanded) } };
      });
    },
    [allExpanded, identity]
  );

  const renderNode = (node: DiffTreeNode, depth: number): React.ReactElement => {
    const paddingLeft = 8 + depth * 14;
    if (node.kind === "directory") {
      const open = expandedDirectories[node.path] ?? allExpanded;
      return (
        <div key={`dir:${node.path}`}>
          <button
            type="button"
            aria-expanded={open}
            style={{ paddingLeft: `${paddingLeft}px` }}
            onClick={() => toggleDirectory(node.path)}
            className="group flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left transition-colors hover:bg-neutral-800/60 focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-500"
          >
            <ChevronRight
              size={14}
              strokeWidth={1.8}
              aria-hidden
              className={cn("ac-chevron shrink-0 text-neutral-500")}
              data-open={open ? "true" : "false"}
            />
            {open ? (
              <Folder size={14} strokeWidth={1.8} aria-hidden className="shrink-0 text-neutral-500" />
            ) : (
              <FolderClosed size={14} strokeWidth={1.8} aria-hidden className="shrink-0 text-neutral-500" />
            )}
            <span className="truncate font-mono text-[11px] text-neutral-400 group-hover:text-neutral-200">
              {node.name}
            </span>
            <DiffStatLabel stat={node.stat} />
          </button>
          {open ? <div>{node.children.map((child) => renderNode(child, depth + 1))}</div> : null}
        </div>
      );
    }
    const fileLine = (
      <>
        {hasDirectories || depth > 0 ? <span aria-hidden className="h-3.5 w-3.5 shrink-0" /> : null}
        <FileIcon size={14} strokeWidth={1.8} aria-hidden className="shrink-0 text-neutral-500" />
        <span className="truncate font-mono text-xs text-neutral-300 group-hover:text-neutral-100">
          {node.name}
        </span>
        {node.stat ? <DiffStatLabel stat={node.stat} /> : null}
      </>
    );
    const { onOpenFile } = ctx;
    // Nothing to open a file with (the embed): the line is a plain one.
    if (!onOpenFile) {
      return (
        <div
          key={`file:${node.path}`}
          style={{ paddingLeft: `${paddingLeft}px` }}
          className="flex w-full items-center gap-2 py-1.5 pr-2"
        >
          {fileLine}
        </div>
      );
    }
    return (
      <button
        key={`file:${node.path}`}
        type="button"
        style={{ paddingLeft: `${paddingLeft}px` }}
        onClick={() => onOpenFile(node.path)}
        className="group flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left transition-colors hover:bg-neutral-800/60 focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-500"
      >
        {fileLine}
      </button>
    );
  };

  return (
    <div className="mt-4 rounded-lg bg-neutral-900">
      <div
        className={cn(
          "flex items-center justify-between gap-2 bg-neutral-900 px-3 py-1.5",
          listOpen ? "sticky top-2 z-10 rounded-t-lg" : "rounded-lg"
        )}
      >
        <button
          type="button"
          aria-expanded={listOpen}
          onClick={() => setListOpen((value) => !value)}
          className="group -ml-1 flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-1 py-0.5 text-left text-xs font-medium text-neutral-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
        >
          <span className="flex items-center gap-1.5">
            <ChevronRight
              size={14}
              strokeWidth={1.8}
              aria-hidden
              className="ac-chevron shrink-0 text-neutral-500 group-hover:text-neutral-300"
              data-open={listOpen ? "true" : "false"}
            />
            {files.length} changed file{files.length === 1 ? "" : "s"}
          </span>
          {hasNonZeroStat(summary) ? (
            <span className="ac-tabular font-mono text-[10px]">
              <span className="text-[color:var(--diff-add-fg)]">+{summary.additions}</span>{" "}
              <span className="text-[color:var(--diff-del-fg)]">−{summary.deletions}</span>
            </span>
          ) : null}
          <ChangeKindSplit files={files} />
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {listOpen && hasDirectories ? (
            <ChatIconButton
              size="xs"
              label={allExpanded ? "Collapse all folders" : "Expand all folders"}
              onClick={() => setAllExpanded((value) => !value)}
            >
              {allExpanded ? (
                <ChevronsDownUp size={12} strokeWidth={1.8} aria-hidden />
              ) : (
                <ChevronsUpDown size={12} strokeWidth={1.8} aria-hidden />
              )}
            </ChatIconButton>
          ) : null}
          {ctx.onOpenTurnDiff ? (
            <ChatIconButton
              size="xs"
              label="Open the full diff for this turn"
              onClick={() => ctx.onOpenTurnDiff?.(turnCount)}
            >
              <FileDiff size={12} strokeWidth={1.8} aria-hidden />
            </ChatIconButton>
          ) : null}
        </div>
      </div>
      {listOpen ? <div className="p-2 pt-0">{tree.map((node) => renderNode(node, 0))}</div> : null}
    </div>
  );
});
