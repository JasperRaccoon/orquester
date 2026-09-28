/**
 * A workflow's run history for `RunsList`: the store's live first page
 * (`useWorkflowRuns` — kept current by the run events) plus older pages
 * fetched on "Load more" with the `before` cursor, one row per run, newest
 * first. Older pages are this list's own (they are nobody else's business);
 * a run in them that the store also knows shows the store's live copy.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { WorkflowRunSummary } from "@orquester/api";

import { useWorkflowRuns } from "../../../lib/workflows/hooks";
import { mergeRunPages } from "../../../lib/workflows/run-view";
import { sanitizeRunList } from "../../../lib/workflows/sanitize";
import { loadWorkflowRuns, workflowsStore, type WorkflowsState } from "../../../lib/workflows/store";
import { errorText, type WorkflowRunsApi } from "./shared";

export const RUN_HISTORY_PAGE = 25;

export interface RunHistory {
  runs: WorkflowRunSummary[];
  /** The first page is on its way. */
  loading: boolean;
  /** The first page failed (no rows to show). */
  error: string | null;
  /** More runs exist beyond the loaded ones. */
  hasMore: boolean;
  loadingMore: boolean;
  /** "Load more" failed. */
  moreError: string | null;
  loadMore: () => void;
  retry: () => void;
}

const runsOf = (state: WorkflowsState): WorkflowsState["runs"] => state.runs;

export function useRunHistory(api: WorkflowRunsApi, workflowId: string | null): RunHistory {
  const first = useWorkflowRuns(workflowId);
  const known = useSyncExternalStore(
    workflowsStore.subscribe,
    () => runsOf(workflowsStore.getState()),
    () => runsOf(workflowsStore.getState())
  );
  const [older, setOlder] = useState<WorkflowRunSummary[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const generation = useRef(0);

  // Another workflow: start over.
  useEffect(() => {
    generation.current += 1;
    setOlder([]);
    setCursor(undefined);
    setLoadingMore(false);
    setMoreError(null);
  }, [workflowId]);

  const next = cursor === undefined ? first.before : cursor;

  const loadMore = useCallback(() => {
    if (!workflowId || loadingMore || next === null || next === undefined) return;
    const gen = generation.current;
    setLoadingMore(true);
    setMoreError(null);
    api
      .listWorkflowRuns(workflowId, { before: next, limit: RUN_HISTORY_PAGE })
      .then((response) => {
        if (gen !== generation.current) return;
        // Off the wire: sanitised like every store load.
        const runs = sanitizeRunList(response?.runs).filter((run) => run.workflowId === workflowId);
        setOlder((current) => [...current, ...runs]);
        setCursor(typeof response?.before === "string" ? response.before : null);
      })
      .catch((error: unknown) => {
        if (gen === generation.current) setMoreError(errorText(error, "Couldn't load older runs."));
      })
      .finally(() => {
        if (gen === generation.current) setLoadingMore(false);
      });
  }, [api, workflowId, loadingMore, next]);

  const retry = useCallback(() => {
    if (workflowId) void loadWorkflowRuns(api, workflowId, { force: true });
  }, [api, workflowId]);

  const runs = useMemo(
    () => mergeRunPages(first.runs, older, (runId) => known[runId]?.summary),
    [first.runs, older, known]
  );

  return {
    runs,
    loading: runs.length === 0 && (first.status === "idle" || first.status === "loading"),
    error: runs.length === 0 && first.status === "error" ? first.error : null,
    hasMore: typeof next === "string" && next.length > 0,
    loadingMore,
    moreError,
    loadMore,
    retry
  };
}
