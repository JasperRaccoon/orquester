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
import { workflowTempProjects, type WorkflowTempProjects } from "./temp-projects";
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

let tempCache: { state: WorkflowsState; value: WorkflowTempProjects } | null = null;

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => {
  if (a.size !== b.size) return false;
  for (const entry of a) if (!b.has(entry)) return false;
  return true;
};

function tempProjectsSnapshot(): WorkflowTempProjects {
  const state = workflowsStore.getState();
  if (tempCache?.state === state) return tempCache.value;
  const next = workflowTempProjects(state);
  // The same answer keeps its identity: a run's progress re-renders nobody.
  const value =
    tempCache && sameSet(tempCache.value.paths, next.paths) && sameSet(tempCache.value.runIdPrefixes, next.runIdPrefixes)
      ? tempCache.value
      : next;
  tempCache = { state, value };
  return value;
}

/** The temporary projects of the runs this client knows (the sidebar's marker, §5.10). */
export function useWorkflowTempProjects(): WorkflowTempProjects {
  return useSyncExternalStore(workflowsStore.subscribe, tempProjectsSnapshot, tempProjectsSnapshot);
}

/** The workflows list's load status alone. */
export function useWorkflowsLoadStatus(): WorkflowsState["load"]["status"] {
  return useSyncExternalStore(
    workflowsStore.subscribe,
    () => workflowsStore.getState().load.status,
    () => workflowsStore.getState().load.status
  );
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
  const stale = entry?.stale === true;

  useEffect(() => {
    watchConnection();
  }, []);

  useEffect(() => {
    if (!connected || !runId) return;
    // Loaded and current: nothing to do. Stale (a reconnect): reload it whole.
    if (loaded && !stale) return;
    void loadWorkflowRun(api, runId, stale ? { force: true } : undefined);
  }, [api, connected, runId, loaded, stale]);

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
