import React, { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, GitBranch, X } from "lucide-react";
import type { GitBranchesResponse, GitStatusResponse } from "@orquester/api";
import { cn } from "../../lib/cn";
import { ApiError } from "../../lib/api-client";
import { EmptyState } from "../main/EmptyState";
import { ChangesPanel } from "./ChangesPanel";
import { GitHeader } from "./GitHeader";
import { HistoryPanel } from "./HistoryPanel";
import { useApi } from "../../context/orquester-context";

type SubTab = "changes" | "history";

const SUB_TABS: { tab: SubTab; label: string }[] = [
  { tab: "changes", label: "Changes" },
  { tab: "history", label: "History" }
];

const repoNameOf = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

/** Best human-readable message for a failed git op: daemon's message, else generic. */
const opErrorMessage = (error: unknown): string => {
  if (error instanceof ApiError && error.serverMessage) {
    return error.serverMessage;
  }
  return error instanceof Error && error.message ? error.message : "Git operation failed.";
};

/**
 * Root of the Git tab (GitHub-Desktop style). Owns the repo's status + branches
 * and a `historyVersion` ticket that drives the History panel's reloads. It
 * reconciles on mount, on window focus, on tab (re)activation, and after any
 * mutation (no polling). Non-git directories render a plain "not a repository"
 * message; repos get the sync header, a Changes|History segmented control, an
 * error banner for failed ops, and the active panel.
 */
export const GitView: React.FC<{ projectPath: string; active?: boolean }> = ({
  projectPath,
  active = true
}) => {
  const api = useApi();
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [branches, setBranches] = useState<GitBranchesResponse | null>(null);
  const [tab, setTab] = useState<SubTab>("changes");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped to make HistoryPanel reload its commit list — the log isn't part of
  // `status`, so a pull/commit would otherwise leave History stale (see reconcile).
  const [historyVersion, setHistoryVersion] = useState(0);

  const refresh = useCallback(() => {
    let cancelled = false;
    Promise.all([api.gitStatus(projectPath), api.gitBranches(projectPath)])
      .then(([s, b]) => {
        if (cancelled) return;
        setStatus(s);
        setBranches(b);
      })
      .catch(() => {
        /* leave the last good snapshot in place */
      });
    return () => {
      cancelled = true;
    };
  }, [api, projectPath]);

  // One "everything changed" signal: re-read status/branches AND reload the
  // History commit list. Used after every mutation and on focus/activation.
  const reconcile = useCallback(() => {
    refresh();
    setHistoryVersion((v) => v + 1);
  }, [refresh]);

  // Refresh on mount/project change and whenever the OS window regains focus.
  useEffect(() => {
    const cancel = refresh();
    const onFocus = () => reconcile();
    window.addEventListener("focus", onFocus);
    return () => {
      cancel();
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh, reconcile]);

  // Refresh when this tab becomes active again. An in-app tab switch doesn't
  // fire window focus, so fetching/committing elsewhere (e.g. a terminal) and
  // returning here would otherwise show stale ahead/behind + history. Skips the
  // initial mount (the effect above already loaded it).
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) {
      reconcile();
    }
    wasActive.current = active;
  }, [active, reconcile]);

  // Drop a stale error when switching repos.
  useEffect(() => {
    setError(null);
  }, [projectPath]);

  // Run a remote/branch op behind a busy flag, then reconcile. A failure is
  // shown in a dismissible banner rather than swallowed (a failed fetch/push
  // used to look like a silent no-op).
  const runOp = useCallback(
    async (name: string, op: () => Promise<unknown>) => {
      setBusy(name);
      setError(null);
      try {
        await op();
      } catch (err) {
        setError(opErrorMessage(err));
      } finally {
        setBusy(null);
        reconcile();
      }
    },
    [reconcile]
  );

  if (status && !status.isRepo) {
    return (
      <EmptyState
        icon={<GitBranch size={40} strokeWidth={1.25} />}
        title="Not a git repository"
        description="This project folder isn't a git repository, so there's nothing to show here."
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-neutral-950">
      <GitHeader
        repoName={repoNameOf(projectPath)}
        status={status}
        branches={branches}
        busy={busy}
        onRefresh={reconcile}
        onFetch={() => void runOp("fetch", () => api.gitFetch(projectPath))}
        onPull={() => void runOp("pull", () => api.gitPull(projectPath))}
        onPush={() => void runOp("push", () => api.gitPush(projectPath))}
        onCheckout={(branch) => void runOp("checkout", () => api.gitCheckout(projectPath, branch))}
      />

      {error && (
        <div className="flex shrink-0 items-start gap-2 border-b border-red-900/50 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          <AlertCircle size={14} className="mt-px shrink-0" />
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono leading-relaxed">
            {error}
          </span>
          <button
            type="button"
            aria-label="Dismiss error"
            onClick={() => setError(null)}
            className="shrink-0 rounded p-0.5 text-red-400/80 transition-colors hover:bg-red-900/40 hover:text-red-200"
          >
            <X size={13} />
          </button>
        </div>
      )}

      {/* Changes | History segmented control */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-neutral-800 px-2">
        <div className="inline-flex items-center gap-0.5 rounded-md bg-neutral-900/60 p-0.5 ring-1 ring-neutral-800">
          {SUB_TABS.map(({ tab: value, label }) => {
            const selected = tab === value;
            return (
              <button
                key={value}
                type="button"
                aria-pressed={selected}
                onClick={() => setTab(value)}
                className={cn(
                  "inline-flex h-6 items-center justify-center rounded px-3 text-xs transition-colors",
                  "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
                  selected ? "bg-neutral-800 text-neutral-100" : "text-neutral-500 hover:text-neutral-200"
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {tab === "changes" ? (
        <ChangesPanel projectPath={projectPath} status={status} onChanged={reconcile} />
      ) : (
        <HistoryPanel projectPath={projectPath} reloadToken={historyVersion} />
      )}
    </div>
  );
};
