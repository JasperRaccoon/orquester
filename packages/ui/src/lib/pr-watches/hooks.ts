/**
 * Pull request watches — the React side of `store.ts`: one chat thread's live
 * watches, loaded while connected (again after a reconnect: `/events` has no
 * replay) and kept current by the app store's event routing.
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import type { PullRequestWatchSummary } from "@orquester/api/agent-chat";

import { useApi } from "../../context/orquester-context";
import { useAppStore } from "../../store/app";
import { loadPullRequestWatches, pullRequestWatchesOf, pullRequestWatchesStore, stopPullRequestWatch } from "./store";

export interface PullRequestWatchesView {
  watches: readonly PullRequestWatchSummary[];
  /** Watch ids whose stop is in flight. */
  stopping: ReadonlySet<string>;
  error: string | null;
  stop(watchId: string): void;
}

const getSnapshot = () => pullRequestWatchesStore.getState();

export function usePullRequestWatches(sessionId: string, enabled = true): PullRequestWatchesView {
  const api = useApi();
  const connected = useAppStore((state) => state.connectionStatus === "connected");
  const state = useSyncExternalStore(pullRequestWatchesStore.subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!enabled || !connected) return;
    void loadPullRequestWatches(api, sessionId);
  }, [api, connected, enabled, sessionId]);

  const stop = useCallback(
    (watchId: string) => {
      void stopPullRequestWatch(api, sessionId, watchId);
    },
    [api, sessionId]
  );

  const watches = pullRequestWatchesOf(state, sessionId);
  const error = state.errors.get(sessionId) ?? null;
  return useMemo(() => ({ watches, stopping: state.stopping, error, stop }), [watches, state.stopping, error, stop]);
}
