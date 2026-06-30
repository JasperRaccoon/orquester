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
import { usePollWhileActive } from "../../hooks";

type SubTab = "changes" | "history";

const SUB_TABS: { tab: SubTab; label: string }[] = [
  { tab: "changes", label: "Changes" },
  { tab: "history", label: "History" }
];

/**
 * How often to run a background `git fetch` while the Git tab is open. The 3s
 * status poll only re-reads LOCAL state; the "behind" count is measured against
 * the remote-tracking ref, which ONLY `git fetch` advances — so this interval is
 * what keeps ahead/behind from silently going stale until a manual Fetch. Kept
 * well above the status poll because it's a real network op, not a local read;
 * the focus/activate triggers cover the "just opened the tab" case, so this is
 * mostly the backstop for sitting on the tab watching.
 */
const AUTO_FETCH_INTERVAL_MS = 60_000;

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
 * mutation, plus a 3s status/branches poll AND a slower background `git fetch`
 * while active so ahead/behind never goes stale without a manual Fetch (history
 * stays event-driven). Non-git directories render a plain "not a repository"
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

  // Monotonic generation so overlapping polls apply in issue order: a slow tick's
  // response is ignored once a newer refresh has started (last-issued-wins).
  const pollGen = useRef(0);
  const refresh = useCallback(() => {
    const gen = ++pollGen.current;
    let cancelled = false;
    Promise.all([api.gitStatus(projectPath), api.gitBranches(projectPath)])
      .then(([s, b]) => {
        if (cancelled || gen !== pollGen.current) return;
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

  // Background `git fetch` that advances the remote-tracking ref so ahead/behind
  // stays current without a manual Fetch. Deliberately NOT routed through runOp:
  // a periodic background fetch must stay silent (offline / no-auth is normal, so
  // no error banner) and must not flip the `busy` flag — that would flash the
  // Fetch button to "Fetching…" and disable the whole cluster every interval.
  // Guarded: skip when there's no upstream (nothing to be behind), while a manual
  // remote op (fetch/pull/push/checkout) is in flight (don't run a second git
  // remote process behind the user's back), when a background fetch is already
  // running, or — unless `force`d — when we fetched within the last interval,
  // which paces the periodic tick + focus trigger and throttles retries while
  // offline. Entering the tab passes `force` so it always refetches.
  const autoFetching = useRef(false);
  const lastAutoFetchAt = useRef(0);
  const autoFetch = useCallback(
    async (opts?: { force?: boolean }) => {
      if (autoFetching.current || busy !== null || !status?.upstream) return;
      // `force` skips only the interval throttle (entering the tab should always
      // fetch); the in-flight / busy / no-upstream guards above still apply.
      if (!opts?.force && Date.now() - lastAutoFetchAt.current < AUTO_FETCH_INTERVAL_MS) return;
      autoFetching.current = true;
      lastAutoFetchAt.current = Date.now();
      try {
        await api.gitFetch(projectPath);
        refresh(); // surface the new ahead/behind + last-fetched right away
      } catch {
        /* offline / no remote / auth prompt — keep the last good snapshot, stay quiet */
      } finally {
        autoFetching.current = false;
      }
    },
    [api, projectPath, busy, status?.upstream, refresh]
  );
  // Stable handle to the latest autoFetch so the entry/focus triggers below can
  // call it without listing it as a dep — otherwise its identity churn (it closes
  // over `busy`, which flips on every manual op) would re-fire those effects and,
  // for the forced entry fetch, fetch spuriously after each fetch/pull/push.
  const autoFetchRef = useRef(autoFetch);
  autoFetchRef.current = autoFetch;

  // Refresh on mount/project change and whenever the OS window regains focus.
  useEffect(() => {
    const cancel = refresh();
    const onFocus = () => {
      reconcile();
      void autoFetchRef.current();
    };
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

  // Fetch whenever the user ENTERS the Git tab: on first load once we know the
  // branch has an upstream, and on every re-activation — the tab stays mounted
  // and just toggles `active`, so active going true IS the "opened the tab"
  // signal. Forced past the interval throttle so entering always pulls the latest
  // remote state, even if you were just here a moment ago. Called via the ref so
  // `busy` churn during a manual op can't trigger a spurious forced fetch.
  useEffect(() => {
    if (active && status?.upstream) void autoFetchRef.current({ force: true });
  }, [active, status?.upstream]);

  // Live-poll status + branches while the tab is open so the Changes list and
  // LOCAL ahead/behind (e.g. a commit made in a terminal) stay fresh without a
  // manual refresh. Polls `refresh` (not `reconcile`) on purpose: history stays
  // event-driven via the focus/activate/mutation reconcile calls, so we don't
  // re-run git log every 3s.
  usePollWhileActive(active, refresh, 3000);

  // …and a slower background `git fetch` on its own cadence so the REMOTE side of
  // ahead/behind stays current too. This is the actual fix for "the Git tab goes
  // stale until I click Fetch": the status poll above only reads local state, so
  // without this nothing ever advances the remote-tracking ref while you sit on
  // the tab.
  usePollWhileActive(active, autoFetch, AUTO_FETCH_INTERVAL_MS);

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
        // A manual fetch/pull just hit the remote, so reset the auto-fetch clock
        // (simply true — we just fetched) to keep the periodic poll from
        // re-fetching seconds later. Push/checkout don't fetch, so they leave it.
        if (name === "fetch" || name === "pull") {
          lastAutoFetchAt.current = Date.now();
        }
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
