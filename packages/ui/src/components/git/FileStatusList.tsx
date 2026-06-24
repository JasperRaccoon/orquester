import React from "react";
import type { GitFileChange, GitFileStatus } from "@orquester/api";
import { cn } from "../../lib/cn";

/** Single-letter badge for a status, matching git's porcelain letters. */
const STATUS_LETTER: Record<GitFileStatus, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typechange: "T",
  untracked: "?",
  conflicted: "U"
};

/** Status letter colors (see the git-tab spec). */
const STATUS_COLOR: Record<GitFileStatus, string> = {
  modified: "text-yellow-500",
  added: "text-green-500",
  deleted: "text-red-500",
  renamed: "text-blue-400",
  copied: "text-blue-400",
  typechange: "text-yellow-500",
  untracked: "text-green-500",
  conflicted: "text-orange-500"
};

const dirOf = (p: string) => {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i + 1);
};
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

interface FileStatusListProps {
  files: GitFileChange[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  checked: Set<string>; // staged-for-commit selection
  onToggle: (path: string) => void;
  onToggleAll: () => void;
  /** Optional trailing per-row affordance (e.g. a ⋯ actions menu). */
  rowAction?: (file: GitFileChange) => React.ReactNode;
}

/**
 * The working-tree changed-files list (GitHub-Desktop style): a select-all
 * header, then one selectable row per file with a per-row checkbox, a colored
 * status letter, and a dir/filename split path. Mirrors FileBrowser row styling.
 */
export const FileStatusList: React.FC<FileStatusListProps> = ({
  files,
  selectedPath,
  onSelect,
  checked,
  onToggle,
  onToggleAll,
  rowAction
}) => {
  const allChecked = files.length > 0 && files.every((f) => checked.has(f.path));
  const someChecked = files.some((f) => checked.has(f.path));

  return (
    <div className="flex min-h-0 flex-col">
      <label className="flex h-9 shrink-0 items-center gap-2 border-b border-neutral-800 px-2.5">
        <input
          type="checkbox"
          checked={allChecked}
          ref={(el) => {
            if (el) el.indeterminate = !allChecked && someChecked;
          }}
          onChange={onToggleAll}
          className="h-3.5 w-3.5 shrink-0 accent-neutral-300"
        />
        <span className="text-xs text-neutral-500">
          {files.length} changed {files.length === 1 ? "file" : "files"}
        </span>
      </label>

      <div className="min-h-0 flex-1 overflow-auto py-1">
        {files.map((file) => {
          const isActive = file.path === selectedPath;
          const dir = dirOf(file.path);
          return (
            <div
              key={file.path}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(file.path)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(file.path);
                }
              }}
              className={cn(
                "group flex w-full cursor-pointer items-center gap-2 py-2 pl-2.5 pr-2 text-left text-sm md:py-1",
                isActive ? "bg-neutral-800 text-neutral-100" : "text-neutral-300 hover:bg-neutral-900"
              )}
            >
              <input
                type="checkbox"
                checked={checked.has(file.path)}
                onClick={(e) => e.stopPropagation()}
                onChange={() => onToggle(file.path)}
                className="h-4 w-4 shrink-0 accent-neutral-300 md:h-3.5 md:w-3.5"
              />
              <span className="min-w-0 flex-1 truncate" title={file.path}>
                {dir && <span className="text-neutral-500">{dir}</span>}
                <span className="text-neutral-200">{baseName(file.path)}</span>
              </span>
              <span className={cn("w-3 shrink-0 text-center font-mono text-xs", STATUS_COLOR[file.status])}>
                {STATUS_LETTER[file.status]}
              </span>
              {rowAction?.(file)}
            </div>
          );
        })}
      </div>
    </div>
  );
};
