import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, GitCommitHorizontal } from "lucide-react";
import type { GitFileChange, GitStatusResponse } from "@orquester/api";
import { cn } from "../../lib/cn";
import { Button, ContextMenu, Input, type ContextMenuItem } from "../ui";
import { DiffView } from "./DiffView";
import { FileStatusList } from "./FileStatusList";
import { useApi } from "../../context/orquester-context";

interface MenuState {
  x: number;
  y: number;
  file: GitFileChange;
}

interface ChangesPanelProps {
  projectPath: string;
  status: GitStatusResponse | null;
  onChanged: () => void;
}

/**
 * The Changes tab (GitHub-Desktop style): the working-tree file list plus a
 * commit box on the left, the selected file's diff on the right. Checkboxes are
 * the staged-for-commit selection — toggling stages/unstages via the daemon and
 * triggers a status refresh. Discard lives behind a right-click confirm.
 */
export const ChangesPanel: React.FC<ChangesPanelProps> = ({ projectPath, status, onChanged }) => {
  const api = useApi();
  const files = useMemo(() => status?.files ?? [], [status]);
  const branch = status?.branch;

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diff, setDiff] = useState("");
  const [diffBinary, setDiffBinary] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [committing, setCommitting] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);

  // The staged selection mirrors the index: files git reports as staged. Kept in
  // sync with the latest status so a refresh reconciles optimistic toggles.
  const [checked, setChecked] = useState<Set<string>>(new Set());
  // Count of stage/unstage ops in flight. While > 0 we don't reconcile `checked`
  // from status, so a background 3s poll landing mid-toggle can't flicker the
  // just-clicked checkbox back off before the op commits to the index.
  const inFlight = useRef(0);
  useEffect(() => {
    if (inFlight.current > 0) return;
    setChecked(new Set(files.filter((f) => f.staged).map((f) => f.path)));
  }, [files]);

  // Keep a valid selection as the file list changes (commits, discards, …).
  useEffect(() => {
    if (selectedPath && !files.some((f) => f.path === selectedPath)) {
      setSelectedPath(files[0]?.path ?? null);
    } else if (!selectedPath && files.length > 0) {
      setSelectedPath(files[0].path);
    }
  }, [files, selectedPath]);

  // A stable signature for the selected file's change state. `status` is re-fetched
  // on GitView's 3s poll, so `files` gets a fresh reference each tick; keying the
  // diff effect on this signature instead of the whole `files` array keeps a
  // background refresh from re-running the fetch (and flashing DiffView's
  // "Loading diff…" placeholder, resetting scroll) when nothing actually changed.
  const selectedSignature = useMemo(() => {
    const file = files.find((f) => f.path === selectedPath);
    return file ? `${file.path}|${file.staged}|${file.unstaged}` : "";
  }, [files, selectedPath]);

  // Fetch the selected file's diff: prefer unstaged changes, fall back to staged.
  useEffect(() => {
    if (!selectedPath) {
      setDiff("");
      setDiffBinary(false);
      return;
    }
    const file = files.find((f) => f.path === selectedPath);
    const staged = file ? !file.unstaged && file.staged : false;
    let active = true;
    setDiffLoading(true);
    api
      .gitDiff(projectPath, selectedPath, { staged })
      .then((res) => {
        if (!active) return;
        setDiff(res.diff);
        setDiffBinary(res.binary);
        setDiffLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setDiff("");
        setDiffBinary(false);
        setDiffLoading(false);
      });
    return () => {
      active = false;
    };
    // Deps use `selectedSignature` (path + staged/unstaged flags) rather than the
    // whole `files` array: a 3s poll returns a fresh `files` reference every tick,
    // but the signature only changes when the selected file's state actually does,
    // so a no-op refresh no longer re-runs this fetch and flashes the placeholder.
  }, [api, projectPath, selectedPath, selectedSignature]);

  const stage = useCallback(
    async (paths: string[], stageIt: boolean) => {
      // Optimistic: the checkbox flips immediately, the refresh reconciles.
      setChecked((prev) => {
        const next = new Set(prev);
        for (const p of paths) {
          if (stageIt) next.add(p);
          else next.delete(p);
        }
        return next;
      });
      inFlight.current += 1;
      try {
        if (stageIt) await api.gitStage(projectPath, paths);
        else await api.gitUnstage(projectPath, paths);
      } finally {
        inFlight.current -= 1;
        onChanged();
      }
    },
    [api, projectPath, onChanged]
  );

  const toggle = (path: string) => void stage([path], !checked.has(path));
  const toggleAll = () => {
    const allChecked = files.length > 0 && files.every((f) => checked.has(f.path));
    void stage(
      files.map((f) => f.path),
      !allChecked
    );
  };

  const discard = async (file: GitFileChange) => {
    if (!window.confirm(`Discard changes to ${file.path}? This cannot be undone.`)) {
      return;
    }
    try {
      await api.gitDiscard(projectPath, [file.path]);
    } finally {
      onChanged();
    }
  };

  const canCommit = summary.trim().length > 0 && checked.size > 0 && !committing;
  const commit = async () => {
    if (!canCommit) {
      return;
    }
    setCommitting(true);
    try {
      await api.gitCommit({
        path: projectPath,
        summary: summary.trim(),
        description: description.trim() || undefined
      });
      setSummary("");
      setDescription("");
      onChanged();
    } catch {
      /* surfaced as a still-populated box */
    } finally {
      setCommitting(false);
    }
  };

  if (files.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
        <p className="text-sm text-neutral-300">No local changes</p>
        <p className="text-xs text-neutral-600">
          There are no uncommitted changes in this repository.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 bg-neutral-950">
      {/* Left column: changed-files list + commit box (full width on mobile). */}
      <div
        className={cn(
          "min-h-0 flex-col border-r border-neutral-800 md:flex md:w-72 md:shrink-0",
          selectedPath ? "hidden md:flex" : "flex w-full"
        )}
      >
        <div className="min-h-0 flex-1" onContextMenu={(e) => e.preventDefault()}>
          <FileStatusListWithMenu
            files={files}
            selectedPath={selectedPath}
            onSelect={setSelectedPath}
            checked={checked}
            onToggle={toggle}
            onToggleAll={toggleAll}
            onContextMenu={(e, file) => {
              e.preventDefault();
              e.stopPropagation();
              setMenu({ x: e.clientX, y: e.clientY, file });
            }}
          />
        </div>

        <div className="shrink-0 space-y-2 border-t border-neutral-800 p-2.5">
          <Input
            placeholder="Summary (required)"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void commit();
            }}
          />
          <textarea
            placeholder="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className={cn(
              "w-full resize-none rounded-md border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 text-sm",
              "text-neutral-100 placeholder:text-neutral-500",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
            )}
          />
          <Button className="w-full" disabled={!canCommit} onClick={() => void commit()}>
            <GitCommitHorizontal size={14} />
            {committing ? "Committing…" : `Commit to ${branch ?? "HEAD"}`}
          </Button>
        </div>
      </div>

      {/* Diff of the selected file (full width on mobile when a file is open). */}
      <div className={cn("min-w-0 flex-1 flex-col", selectedPath ? "flex" : "hidden md:flex")}>
        {selectedPath ? (
          <>
            <div className="flex h-9 shrink-0 items-center gap-2 border-b border-neutral-800 px-2">
              <button
                type="button"
                aria-label="Back to changes"
                onClick={() => setSelectedPath(null)}
                className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 md:hidden"
              >
                <ArrowLeft size={15} />
              </button>
              <span className="truncate text-xs text-neutral-300" title={selectedPath}>
                {selectedPath}
              </span>
            </div>
            <DiffView diff={diff} binary={diffBinary} loading={diffLoading} emptyLabel="No changes" />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-neutral-600">
            Select a file to view its diff
          </div>
        )}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={
            [
              {
                label: "Discard changes",
                danger: true,
                onClick: () => void discard(menu.file)
              }
            ] satisfies ContextMenuItem[]
          }
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
};

/**
 * Thin wrapper that adds a right-click handler around the FileStatusList rows.
 * FileStatusList itself stays presentational; the menu state lives in the panel.
 * Each row tags its path span with `title={file.path}`, so we resolve the
 * right-clicked file from the nearest titled ancestor.
 */
const FileStatusListWithMenu: React.FC<
  React.ComponentProps<typeof FileStatusList> & {
    onContextMenu: (e: React.MouseEvent, file: GitFileChange) => void;
  }
> = ({ onContextMenu, files, ...rest }) => (
  <div
    onContextMenu={(e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[title]");
      const file = el && files.find((f) => f.path === el.title);
      if (file) onContextMenu(e, file);
    }}
    className="flex h-full min-h-0 flex-col"
  >
    <FileStatusList files={files} {...rest} />
  </div>
);
