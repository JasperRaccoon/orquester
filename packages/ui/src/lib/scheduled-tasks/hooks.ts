/**
 * Scheduled tasks — the React side of `store.ts`: one chat thread's tasks, loaded while connected
 * and reloaded after a reconnect (the `/events` stream has no replay).
 *
 * Not imported by the app store (which imports `store.ts` directly), so this module may read the
 * app store without an import cycle.
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import type { ScheduledTask } from "@orquester/api";

import { useApi } from "../../context/orquester-context";
import { useAppStore } from "../../store/app";
import { loadThreadScheduledTasks, markScheduledTasksStale, scheduledTasksStore } from "./store";

export interface ThreadScheduledTasksView {
  /** This thread's tasks, unordered. */
  tasks: readonly ScheduledTask[];
  /** Ids with a Cancel or Run now in flight. */
  busy: ReadonlySet<string>;
  /** The last failed action on this thread's tasks. */
  notice: string | null;
  /** Why the last load failed, or null. */
  loadError: string | null;
  /** Load the thread's tasks again (after a failed load). */
  retry: () => void;
}

let watchingConnection = false;

function watchConnection(): void {
  if (watchingConnection) return;
  watchingConnection = true;
  let previous = useAppStore.getState().connectionStatus;
  useAppStore.subscribe((state) => {
    const status = state.connectionStatus;
    if (status === previous) return;
    const was = previous;
    previous = status;
    if (status === "connected" && was !== "connected") markScheduledTasksStale();
  });
}

const getSnapshot = () => scheduledTasksStore.getState();

export function useThreadScheduledTasks(sessionId: string): ThreadScheduledTasksView {
  const api = useApi();
  const connected = useAppStore((state) => state.connectionStatus === "connected");
  const state = useSyncExternalStore(scheduledTasksStore.subscribe, getSnapshot, getSnapshot);
  const load = state.loads[sessionId];
  const needsLoad = load === undefined || load.stale;

  useEffect(() => {
    watchConnection();
  }, []);

  useEffect(() => {
    if (!connected || !needsLoad) return;
    void loadThreadScheduledTasks(api, sessionId);
  }, [api, connected, sessionId, needsLoad]);

  const retry = useCallback(() => {
    void loadThreadScheduledTasks(api, sessionId);
  }, [api, sessionId]);
  const tasks = useMemo(() => [...state.tasks.values()].filter((task) => task.threadId === sessionId), [state.tasks, sessionId]);
  return {
    tasks,
    busy: state.busy,
    notice: state.notices[sessionId] ?? null,
    loadError: load?.status === "error" ? load.error ?? "the daemon did not answer." : null,
    retry
  };
}
