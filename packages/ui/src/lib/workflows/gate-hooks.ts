/**
 * Automated workflows — the React side of the gates in `store.ts` (spec
 * 2026-11-10 §6.4): a run's gates, a workflow's waiting ones, and the
 * "Needs you" rows with their count, loaded while connected and asked again
 * after a reconnect (the event stream has no replay).
 */

import { useEffect, useSyncExternalStore } from "react";

import type { WorkflowGateState } from "@orquester/api";

import { useApi } from "../../context/orquester-context";
import { useAppStore } from "../../store/app";
import { gateAttentionRows, waitingGatesOfWorkflow, type GateAttentionRow } from "./gates";
import { watchConnection } from "./hooks";
import { loadWorkflowGates, workflowsStore, type WorkflowsState } from "./store";

const NO_GATES: Readonly<Record<string, WorkflowGateState>> = Object.freeze({});

/** A run's gates by id (empty until any is known), kept live by the run's events. */
export function useRunGates(runId: string | null | undefined): Readonly<Record<string, WorkflowGateState>> {
  const read = (): Readonly<Record<string, WorkflowGateState>> =>
    (runId ? workflowsStore.getState().gates[runId] : undefined) ?? NO_GATES;
  return useSyncExternalStore(workflowsStore.subscribe, read, read);
}

/** Keeps the cross-project gate list loaded while connected: on mount, when it goes stale (a reconnect, a missed gate). */
export function useWorkflowGatesLoad(): void {
  const api = useApi();
  const connected = useAppStore((state) => state.connectionStatus === "connected");
  const read = (): boolean => workflowsStore.getState().gatesLoad.stale;
  const stale = useSyncExternalStore(workflowsStore.subscribe, read, read);
  useEffect(() => {
    watchConnection();
  }, []);
  useEffect(() => {
    if (!connected) return;
    void loadWorkflowGates(api);
  }, [api, connected, stale]);
}

// The rows keep their identity while what they say is the same: a run's progress re-renders nobody.
let rowsCache: { gates: WorkflowsState["gates"]; summaries: WorkflowsState["summaries"]; runs: WorkflowsState["runs"]; rows: GateAttentionRow[]; text: string } | null = null;

function rowsSnapshot(): GateAttentionRow[] {
  const state = workflowsStore.getState();
  if (rowsCache && rowsCache.gates === state.gates && rowsCache.summaries === state.summaries && rowsCache.runs === state.runs) {
    return rowsCache.rows;
  }
  const rows = gateAttentionRows(state.gates, {
    workflowName: (workflowId) => state.summaries.get(workflowId)?.name,
    runProjectPath: (runId) => state.runs[runId]?.summary.projectPath
  });
  const text = JSON.stringify(rows);
  const kept = rowsCache && rowsCache.text === text ? rowsCache.rows : rows;
  rowsCache = { gates: state.gates, summaries: state.summaries, runs: state.runs, rows: kept, text };
  return kept;
}

/**
 * The "Needs you" rows — every gate waiting for the person, test runs' aside. Reads the store only:
 * the mounted `WorkflowsHost` keeps the list loaded (`useWorkflowGatesLoad`), so the badges need no API.
 */
export function useGateAttention(): readonly GateAttentionRow[] {
  return useSyncExternalStore(workflowsStore.subscribe, rowsSnapshot, rowsSnapshot);
}

const workflowCache = new Map<string, { gates: WorkflowsState["gates"]; list: WorkflowGateState[] }>();

/** A workflow's gates waiting on a decision (its rail card's decision cards), oldest first. */
export function useWorkflowWaitingGates(workflowId: string): readonly WorkflowGateState[] {
  const read = (): WorkflowGateState[] => {
    const state = workflowsStore.getState();
    const held = workflowCache.get(workflowId);
    if (held && held.gates === state.gates) return held.list;
    const list = waitingGatesOfWorkflow(state.gates, workflowId, (runId) => state.runs[runId]?.summary.workflowId);
    const same = held && held.list.length === list.length && held.list.every((gate, index) => gate === list[index]);
    const value = same ? held.list : list;
    workflowCache.set(workflowId, { gates: state.gates, list: value });
    return value;
  };
  return useSyncExternalStore(workflowsStore.subscribe, read, read);
}
