import React, { useCallback, useEffect, useState } from "react";
import { GitBranch } from "lucide-react";
import type { GitBranchesResponse, GitStatusResponse } from "@orquester/api";
import { cn } from "../../lib/cn";
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

/**
 * Root of the Git tab (GitHub-Desktop style). Owns the repo's status + branches,
 * refreshing them on mount, on window focus, and after any mutation (no polling
 * in v1). Non-git directories render a plain "not a repository" message; repos
 * get the sync header, a Changes|History segmented control, and the active panel.
 */
export const GitView: React.FC<{ projectPath: string }> = ({ projectPath }) => {
  const api = useApi();
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [branches, setBranches] = useState<GitBranchesResponse | null>(null);
  const [tab, setTab] = useState<SubTab>("changes");
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(() => {
    let active = true;
    Promise.all([api.gitStatus(projectPath), api.gitBranches(projectPath)])
      .then(([s, b]) => {
        if (!active) return;
        setStatus(s);
        setBranches(b);
      })
      .catch(() => {
        /* leave the last good snapshot in place */
      });
    return () => {
      active = false;
    };
  }, [api, projectPath]);

  // Refresh on mount/project change and whenever the window regains focus.
  useEffect(() => {
    const cancel = refresh();
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      cancel();
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  // Run a remote/branch op behind a busy flag, then reconcile via a refresh.
  const runOp = useCallback(
    async (name: string, op: () => Promise<unknown>) => {
      setBusy(name);
      try {
        await op();
      } catch {
        /* surfaced on the next refresh (ahead/behind, branch, …) */
      } finally {
        setBusy(null);
        refresh();
      }
    },
    [refresh]
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
        onRefresh={refresh}
        onFetch={() => void runOp("fetch", () => api.gitFetch(projectPath))}
        onPull={() => void runOp("pull", () => api.gitPull(projectPath))}
        onPush={() => void runOp("push", () => api.gitPush(projectPath))}
        onCheckout={(branch) => void runOp("checkout", () => api.gitCheckout(projectPath, branch))}
      />

      {/* Changes | History segmented control */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-neutral-800 px-2">
        <div className="inline-flex items-center gap-0.5 rounded-md bg-neutral-900/60 p-0.5 ring-1 ring-neutral-800">
          {SUB_TABS.map(({ tab: value, label }) => {
            const active = tab === value;
            return (
              <button
                key={value}
                type="button"
                aria-pressed={active}
                onClick={() => setTab(value)}
                className={cn(
                  "inline-flex h-6 items-center justify-center rounded px-3 text-xs transition-colors",
                  "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
                  active ? "bg-neutral-800 text-neutral-100" : "text-neutral-500 hover:text-neutral-200"
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {tab === "changes" ? (
        <ChangesPanel projectPath={projectPath} status={status} onChanged={refresh} />
      ) : (
        <HistoryPanel projectPath={projectPath} />
      )}
    </div>
  );
};
