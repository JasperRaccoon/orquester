import React, { useCallback, useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { GitCommitDetail, GitCommitFile, GitFileStatus, GitLogEntry } from "@orquester/api";
import { cn } from "../../lib/cn";
import { Button } from "../ui";
import { DiffView } from "./DiffView";
import { useApi } from "../../context/orquester-context";

const PAGE = 50;

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

/** Relative author-date label, in the same voice as GitHeader's last-fetched. */
const relativeDate = (iso: string): string => {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return "";
  }
  const mins = Math.round((Date.now() - then) / 60_000);
  if (mins < 1) {
    return "just now";
  }
  if (mins < 60) {
    return `${mins}m ago`;
  }
  const hours = Math.round(mins / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  if (days < 30) {
    return `${days}d ago`;
  }
  return new Date(iso).toLocaleDateString();
};

interface HistoryPanelProps {
  projectPath: string;
  /**
   * Bumped by GitView after anything that can change the commit graph (pull,
   * commit, checkout, fetch) and on tab activation / window focus. A change
   * reloads the commit list in place. Without it the log only ever loaded once
   * on mount, so freshly pulled commits stayed hidden until the Git tab was
   * closed and reopened (which remounts this panel).
   */
  reloadToken?: number;
}

/**
 * The History sub-tab (GitHub-Desktop style): a paginated commit list on the
 * left, the selected commit's changed files in the middle, and the selected
 * file's diff on the right. Responsive: on narrow screens it's a three-stage
 * master/detail (commits → files → diff, each with a back button).
 */
export const HistoryPanel: React.FC<HistoryPanelProps> = ({ projectPath, reloadToken = 0 }) => {
  const api = useApi();
  const [commits, setCommits] = useState<GitLogEntry[]>([]);
  const [loadingLog, setLoadingLog] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [done, setDone] = useState(false);

  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diff, setDiff] = useState("");
  const [diffBinary, setDiffBinary] = useState(false);
  const [loadingDiff, setLoadingDiff] = useState(false);

  // Clear the selection when the repo (project) changes — but NOT on a plain
  // reload, so a pull/commit/refresh keeps whatever commit the user was viewing.
  useEffect(() => {
    setSelectedSha(null);
    setDetail(null);
    setSelectedFile(null);
    setDiff("");
    setDiffBinary(false);
  }, [projectPath]);

  // (Re)load the first page of commits: on mount, on repo change, and whenever
  // GitView bumps `reloadToken` (after a pull/commit/fetch/checkout, or on tab
  // activation / window focus). The list is refreshed in place — existing rows
  // stay visible while reloading, so there's no flash on a routine refresh.
  useEffect(() => {
    setDone(false);
    setLoadingLog(true);
    let active = true;
    api
      .gitLog(projectPath, { limit: PAGE })
      .then((entries) => {
        if (!active) return;
        setCommits(entries);
        setDone(entries.length < PAGE);
      })
      .catch(() => active && setCommits([]))
      .finally(() => active && setLoadingLog(false));
    return () => {
      active = false;
    };
  }, [api, projectPath, reloadToken]);

  const loadMore = useCallback(async () => {
    if (loadingMore || done) {
      return;
    }
    setLoadingMore(true);
    try {
      const next = await api.gitLog(projectPath, { skip: commits.length, limit: PAGE });
      setCommits((prev) => [...prev, ...next]);
      if (next.length < PAGE) {
        setDone(true);
      }
    } catch {
      /* keep what we have */
    } finally {
      setLoadingMore(false);
    }
  }, [api, projectPath, commits.length, loadingMore, done]);

  const selectFile = useCallback(
    (sha: string, file: GitCommitFile) => {
      setSelectedFile(file.path);
      if (file.binary) {
        setDiff("");
        setDiffBinary(true);
        return;
      }
      setLoadingDiff(true);
      setDiffBinary(false);
      api
        .gitDiff(projectPath, file.path, { commit: sha })
        .then((res) => {
          setDiff(res.diff);
          setDiffBinary(res.binary);
        })
        .catch(() => {
          setDiff("");
          setDiffBinary(false);
        })
        .finally(() => setLoadingDiff(false));
    },
    [api, projectPath]
  );

  const selectCommit = useCallback(
    (sha: string) => {
      setSelectedSha(sha);
      setSelectedFile(null);
      setDiff("");
      setDiffBinary(false);
      setDetail(null);
      setLoadingDetail(true);
      let active = true;
      api
        .gitCommitDetail(projectPath, sha)
        .then((d) => {
          if (!active) return;
          setDetail(d);
          // Auto-select the first file so the diff pane isn't empty.
          if (d.files[0]) {
            selectFile(sha, d.files[0]);
          }
        })
        .catch(() => active && setDetail(null))
        .finally(() => active && setLoadingDetail(false));
      return () => {
        active = false;
      };
    },
    [api, projectPath, selectFile]
  );

  return (
    <div className="flex h-full min-h-0 bg-neutral-950">
      {/* Commit list (full width on mobile until a commit is picked) */}
      <div
        className={cn(
          "min-h-0 flex-col border-r border-neutral-800 md:flex md:w-72 md:shrink-0",
          selectedSha ? "hidden md:flex" : "flex w-full"
        )}
      >
        <div className="flex h-9 shrink-0 items-center border-b border-neutral-800 px-2.5">
          <span className="text-xs text-neutral-500">History</span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {loadingLog && commits.length === 0 ? (
            <p className="px-3 py-2 text-xs text-neutral-600">Loading…</p>
          ) : commits.length === 0 ? (
            <p className="px-3 py-2 text-xs text-neutral-600">No commits yet.</p>
          ) : (
            <>
              {commits.map((commit) => (
                <CommitRow
                  key={commit.sha}
                  commit={commit}
                  active={commit.sha === selectedSha}
                  onSelect={() => selectCommit(commit.sha)}
                />
              ))}
              {!done && (
                <div className="px-2.5 py-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full"
                    disabled={loadingMore}
                    onClick={() => void loadMore()}
                  >
                    {loadingMore ? "Loading…" : "Load more"}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Commit's changed files (mobile: shown once a commit is picked, until a file is) */}
      <div
        className={cn(
          "min-h-0 flex-col border-r border-neutral-800 md:flex md:w-72 md:shrink-0",
          selectedSha && !selectedFile ? "flex w-full" : "hidden md:flex"
        )}
      >
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-neutral-800 px-2">
          <button
            type="button"
            aria-label="Back to history"
            onClick={() => setSelectedSha(null)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 md:hidden"
          >
            <ArrowLeft size={15} />
          </button>
          <span className="truncate text-xs text-neutral-500">
            {detail ? `${detail.files.length} changed ${detail.files.length === 1 ? "file" : "files"}` : "Files"}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {detail && (
            <div className="border-b border-neutral-800 px-3 py-2">
              <p className="truncate text-sm text-neutral-200" title={detail.subject}>
                {detail.subject}
              </p>
              <p className="mt-0.5 text-xs text-neutral-500">
                {detail.authorName} · {detail.shortSha}
              </p>
            </div>
          )}
          <div className="py-1">
            {loadingDetail ? (
              <p className="px-3 py-2 text-xs text-neutral-600">Loading…</p>
            ) : !selectedSha ? (
              <p className="px-3 py-2 text-xs text-neutral-600">Select a commit.</p>
            ) : (
              detail?.files.map((file) => (
                <CommitFileRow
                  key={file.path}
                  file={file}
                  active={file.path === selectedFile}
                  onSelect={() => selectedSha && selectFile(selectedSha, file)}
                />
              ))
            )}
          </div>
        </div>
      </div>

      {/* Diff pane (full width on mobile when a file is selected) */}
      <div className={cn("min-w-0 flex-1 flex-col", selectedFile ? "flex" : "hidden md:flex")}>
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-neutral-800 px-2">
          <button
            type="button"
            aria-label="Back to files"
            onClick={() => setSelectedFile(null)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 md:hidden"
          >
            <ArrowLeft size={15} />
          </button>
          <span className="truncate text-xs text-neutral-300">{selectedFile ? baseName(selectedFile) : ""}</span>
        </div>
        {selectedFile ? (
          <DiffView diff={diff} binary={diffBinary} loading={loadingDiff} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-neutral-600">
            Select a commit to view its changes
          </div>
        )}
      </div>
    </div>
  );
};

const CommitRow: React.FC<{ commit: GitLogEntry; active: boolean; onSelect: () => void }> = ({
  commit,
  active,
  onSelect
}) => (
  <div
    role="button"
    tabIndex={0}
    onClick={onSelect}
    onKeyDown={(e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelect();
      }
    }}
    className={cn(
      "flex w-full cursor-pointer flex-col gap-0.5 px-3 py-1.5 text-left",
      active ? "bg-neutral-800" : "hover:bg-neutral-900"
    )}
  >
    <span className={cn("truncate text-sm", active ? "text-neutral-100" : "text-neutral-300")} title={commit.subject}>
      {commit.subject}
    </span>
    <span className="flex items-center gap-1.5 text-xs text-neutral-500">
      <span className="min-w-0 truncate">{commit.authorName}</span>
      <span className="shrink-0">·</span>
      <span className="shrink-0">{relativeDate(commit.date)}</span>
      <span className="ml-auto shrink-0 font-mono text-neutral-600">{commit.shortSha}</span>
    </span>
    {commit.refs.length > 0 && (
      <span className="flex flex-wrap gap-1 pt-0.5">
        {commit.refs.map((ref) => (
          <span
            key={ref}
            className="rounded border border-neutral-700 bg-neutral-900 px-1 text-[10px] text-neutral-400"
          >
            {ref}
          </span>
        ))}
      </span>
    )}
  </div>
);

const CommitFileRow: React.FC<{ file: GitCommitFile; active: boolean; onSelect: () => void }> = ({
  file,
  active,
  onSelect
}) => {
  const dir = dirOf(file.path);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 py-1 pl-2.5 pr-2 text-left text-sm",
        active ? "bg-neutral-800 text-neutral-100" : "text-neutral-300 hover:bg-neutral-900"
      )}
    >
      <span className={cn("w-3 shrink-0 text-center font-mono text-xs", STATUS_COLOR[file.status])}>
        {STATUS_LETTER[file.status]}
      </span>
      <span className="min-w-0 flex-1 truncate" title={file.path}>
        {dir && <span className="text-neutral-500">{dir}</span>}
        <span className="text-neutral-200">{baseName(file.path)}</span>
      </span>
      {file.binary ? (
        <span className="shrink-0 font-mono text-xs text-neutral-600">bin</span>
      ) : (
        <span className="shrink-0 font-mono text-xs tabular-nums">
          <span className="text-green-500">+{file.additions}</span>{" "}
          <span className="text-red-500">-{file.deletions}</span>
        </span>
      )}
    </div>
  );
};
