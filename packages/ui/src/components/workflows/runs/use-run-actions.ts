/**
 * What a run header's buttons do (spec §7.3): Cancel run, Retry run, Retry
 * from failed block, Delete temp project now — each with its busy state and a
 * failure message the header shows. Retries go through the store's Run now,
 * so an overlap skip becomes the rail's "Run anyway" notice as for any run.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { WorkflowRunSummary, WorkflowTriggerPayload } from "@orquester/api";

import { retryFromFailedRequest, retryRunRequest } from "../../../lib/workflows/run-view";
import { loadWorkflowRun, runWorkflowNow } from "../../../lib/workflows/store";
import { errorText, type WorkflowRunsApi } from "./shared";

export type RunActionKind = "cancel" | "retry" | "retry-failed" | "delete-temp";

export interface RunActionsState {
  /** The action on its way, if any. */
  busy: RunActionKind | null;
  /** The last action's failure. */
  error: string | null;
  dismissError: () => void;
  cancel: () => void;
  retry: () => void;
  retryFromFailed: () => void;
  deleteTempProject: () => void;
}

export function useRunActions(
  api: WorkflowRunsApi,
  run: WorkflowRunSummary | null,
  triggerPayload: WorkflowTriggerPayload | null | undefined,
  options: {
    /** A retry started a new run (select it). */
    onStarted?: (runId: string) => void;
  } = {}
): RunActionsState {
  const [busy, setBusy] = useState<RunActionKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const onStarted = useRef(options.onStarted);
  onStarted.current = options.onStarted;

  // Another run: its own state.
  const runId = run?.id ?? null;
  useEffect(() => {
    setBusy(null);
    setError(null);
  }, [runId]);

  const act = useCallback(
    (kind: RunActionKind, work: () => Promise<void>) => {
      if (busy !== null) return;
      setBusy(kind);
      setError(null);
      work()
        .catch((reason: unknown) => {
          if (mounted.current) setError(errorText(reason));
        })
        .finally(() => {
          if (mounted.current) setBusy(null);
        });
    },
    [busy]
  );

  const start = useCallback(
    async (request: Parameters<typeof runWorkflowNow>[2]) => {
      if (!run) return;
      const result = await runWorkflowNow(api, run.workflowId, request);
      if (!result.ok) throw new Error(result.error);
      const started = result.value.runId;
      if (started) onStarted.current?.(started);
    },
    [api, run]
  );

  return {
    busy,
    error,
    dismissError: () => setError(null),
    cancel: () =>
      act("cancel", async () => {
        if (!run) return;
        await api.cancelWorkflowRun(run.id);
      }),
    retry: () => act("retry", () => start(run ? retryRunRequest(run, triggerPayload) : {})),
    retryFromFailed: () => act("retry-failed", () => start(run ? retryFromFailedRequest(run) : {})),
    deleteTempProject: () =>
      act("delete-temp", async () => {
        if (!run) return;
        await api.deleteWorkflowRunTempProject(run.id);
        // The run's `tempProject.deleted` flips on the daemon; read it back.
        await loadWorkflowRun(api, run.id, { force: true });
      })
  };
}
