/**
 * Automated workflows — the React side of `store.ts`: what the rail and the
 * editor read, loaded while connected and refreshed after a reconnect.
 *
 * Not imported by the app store (which imports `store.ts` directly), so this
 * module may read the app store without an import cycle.
 */

import { useEffect, useMemo, useSyncExternalStore } from "react";

import type { WorkflowSecretName, WorkflowSummary } from "@orquester/api";

import { useApi } from "../../context/orquester-context";
import { useAppStore } from "../../store/app";
import { workflowInProject } from "./format";
import {
  loadWorkflowRun,
  loadWorkflowRuns,
  loadWorkflows,
  loadWorkflowSecrets,
  markWorkflowsStale,
  workflowSecretsKey,
  workflowsStore,
  withEnabledOverride,
  type WorkflowRunEntry,
  type WorkflowRunsList,
  type WorkflowsLoadStatus,
  type WorkflowsNotice,
  type WorkflowsState
} from "./store";

let watchingConnection = false;

/**
 * Mark everything loaded stale whenever the connection comes back: the
 * `/events` stream has no replay, so a change made while it was down is only
 * seen by asking again. Installed once, on the first mount of a reader.
 */
function watchConnection(): void {
  if (watchingConnection) return;
  watchingConnection = true;
  let previous = useAppStore.getState().connectionStatus;
  useAppStore.subscribe((state) => {
    const status = state.connectionStatus;
    if (status === previous) return;
    const was = previous;
    previous = status;
    if (status === "connected" && was !== "connected") markWorkflowsStale();
  });
}

const getSnapshot = (): WorkflowsState => workflowsStore.getState();

/** The whole workflows store, re-rendering on every change. */
export function useWorkflowsState(): WorkflowsState {
  return useSyncExternalStore(workflowsStore.subscribe, getSnapshot, getSnapshot);
}

function useConnected(): boolean {
  return useAppStore((state) => state.connectionStatus === "connected");
}

export interface WorkflowsView {
  /** By name; pending enabled flips applied. Narrowed to one project when asked. */
  workflows: readonly WorkflowSummary[];
  /** Not asked yet (not connected) reads as `loading`. */
  status: Exclude<WorkflowsLoadStatus, "idle">;
  error: string | null;
  refreshing: boolean;
  notice: WorkflowsNotice | null;
}

/**
 * Every workflow (or only `projectPath`'s own, when given), loading them
 * while connected — on mount and after a reconnect.
 */
export function useWorkflows(projectPath?: string | null): WorkflowsView {
  const api = useApi();
  const connected = useConnected();
  const state = useWorkflowsState();
  const stale = state.load.stale;

  useEffect(() => {
    watchConnection();
  }, []);

  useEffect(() => {
    if (!connected) return;
    void loadWorkflows(api);
  }, [api, connected, stale]);

  const workflows = useMemo(() => {
    const out: WorkflowSummary[] = [];
    for (const summary of state.summaries.values()) {
      if (projectPath && !workflowInProject(summary, projectPath)) continue;
      out.push(withEnabledOverride(summary, state.enabledOverrides));
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || (a.id < b.id ? -1 : 1));
  }, [state.summaries, state.enabledOverrides, projectPath]);

  const status = state.load.status === "idle" ? "loading" : state.load.status;
  return useMemo(
    () => ({ workflows, status, error: state.load.error, refreshing: state.load.refreshing, notice: state.notice }),
    [workflows, status, state.load.error, state.load.refreshing, state.notice]
  );
}

const NO_RUNS: WorkflowRunsList = {
  status: "idle",
  error: null,
  refreshing: false,
  stale: false,
  runs: [],
  before: null
};

/** A workflow's last runs (`null` = none asked), loaded while connected and refreshed when stale. */
export function useWorkflowRuns(workflowId: string | null): WorkflowRunsList {
  const api = useApi();
  const connected = useConnected();
  const list = useSyncExternalStore(
    workflowsStore.subscribe,
    () => (workflowId ? workflowsStore.getState().recentRuns[workflowId] : undefined) ?? NO_RUNS,
    () => NO_RUNS
  );
  const stale = list.stale;

  useEffect(() => {
    watchConnection();
  }, []);

  useEffect(() => {
    if (!connected || !workflowId) return;
    void loadWorkflowRuns(api, workflowId);
  }, [api, connected, workflowId, stale]);

  return list;
}

/** One run, loaded whole (definition, blocks) and kept live by the run events. */
export function useWorkflowRun(runId: string | null): WorkflowRunEntry | null {
  const api = useApi();
  const connected = useConnected();
  const entry = useSyncExternalStore(
    workflowsStore.subscribe,
    () => (runId ? (workflowsStore.getState().runs[runId] ?? null) : null),
    () => null
  );
  const loaded = entry?.detail != null;

  useEffect(() => {
    watchConnection();
  }, []);

  useEffect(() => {
    if (!connected || !runId || loaded) return;
    void loadWorkflowRun(api, runId);
  }, [api, connected, runId, loaded]);

  return entry;
}

export interface WorkflowSecretsView {
  secrets: readonly WorkflowSecretName[];
  status: Exclude<WorkflowsLoadStatus, "idle">;
  error: string | null;
  refreshing: boolean;
}

/** Secret names: the global ones, plus `workflowId`'s own when given. */
export function useWorkflowSecrets(workflowId?: string | null, options?: { enabled?: boolean }): WorkflowSecretsView {
  const api = useApi();
  const connected = useConnected();
  const key = workflowSecretsKey(workflowId);
  const state = useWorkflowsState();
  const list = state.secrets[key];
  const stale = list?.stale ?? false;
  const enabled = options?.enabled ?? true;

  useEffect(() => {
    watchConnection();
  }, []);

  useEffect(() => {
    if (!connected || !enabled) return;
    void loadWorkflowSecrets(api, workflowId ?? null);
    // `key` stands for `workflowId`; `stale` re-runs it after a change was announced.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, connected, key, stale, enabled]);

  const status = !list || list.status === "idle" ? "loading" : list.status;
  return useMemo(
    () => ({
      secrets: list?.secrets ?? [],
      status,
      error: list?.error ?? null,
      refreshing: list?.refreshing ?? false
    }),
    [list, status]
  );
}
