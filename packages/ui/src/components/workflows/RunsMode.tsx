/**
 * The editor tab's Runs mode (workflows spec §7.3, §7.4) — the renderer
 * registered with `registerWorkflowRunsMode`, composed from the run view's
 * components:
 *
 * - **Desktop:** the runs list (live, filterable, paged) on the left; the
 *   selected run's header (status, trigger, timing, Cancel / Retry / Retry
 *   from failed block / Delete temp project) over its FROZEN definition drawn
 *   read-only with the run overlay (click a block to select it); the selected
 *   block's run details on the right — its failed, live or last block by
 *   default.
 * - **Phone:** the run's step timeline (tap a step → its details in a sheet,
 *   with Open session), the runs list one tap away in a sheet, and the canvas
 *   overlay one tap away.
 *
 * Live runs stay current through the workflows store (`useWorkflowRun`). A
 * retry selects the run it started.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, History, ListTree, Network, PencilRuler } from "lucide-react";

import { isRunActive } from "@orquester/api";

import { useApi } from "../../context/orquester-context";
import { cn } from "../../lib/cn";
import { formatAgo } from "../../lib/workflows/format";
import { useWorkflowRun } from "../../lib/workflows/hooks";
import { deriveRunOverlay } from "../../lib/workflows/overlay";
import { runStatusView, runTimeline, type RunStatusFilter } from "../../lib/workflows/run-view";
import { pickBlockId, pickRunId, type PhoneRunPane } from "../../lib/workflows/runs-mode";
import type { WorkflowRunEntry } from "../../lib/workflows/store";
import { StandaloneWorkflowCanvas } from "./canvas/WorkflowCanvas";
import { usePhoneLayout } from "./phone/phone-context";
import { WorkflowSheet } from "./phone/WorkflowSheet";
import { BlockRunDetails } from "./runs/BlockRunDetails";
import { focusWorkflowSession, isWorkflowSessionOpen, type OpenSessionResult } from "./runs/open-run";
import { RunHeader } from "./runs/RunHeader";
import { RunsList } from "./runs/RunsList";
import { RunTimeline } from "./runs/RunTimeline";
import { StatusGlyph, useNow, type WorkflowRunsApi } from "./runs/shared";
import { useRunActions } from "./runs/use-run-actions";
import { useRunHistory } from "./runs/use-run-history";
import { useRunOnScreen } from "./runs/use-run-on-screen";
import type { WorkflowRunsModeContext } from "./WorkflowEditorTab";

export function renderWorkflowRunsMode(context: WorkflowRunsModeContext): React.ReactNode {
  return <WorkflowRunsMode {...context} />;
}

export const WorkflowRunsMode: React.FC<WorkflowRunsModeContext> = (context) => {
  const phone = usePhoneLayout();
  return phone ? <PhoneRuns {...context} /> : <DesktopRuns {...context} />;
};

/** Everything both layouts read: the history, the run, its timeline, the selected block. */
function useRunsView(context: WorkflowRunsModeContext) {
  const api = useApi() as unknown as WorkflowRunsApi;
  const history = useRunHistory(api, context.workflowId);
  const runId = pickRunId(context.runId, history.runs);
  const entry = useWorkflowRun(runId);
  const live = entry ? isRunActive(entry.summary.status) : history.runs.some((run) => isRunActive(run.status));
  useRunOnScreen(entry ? runId : null, context.show, entry !== null && !isRunActive(entry.summary.status));
  const now = useNow(live);
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => setPicked(null), [runId]);

  const definition = entry?.detail?.definition ?? null;
  const status = entry?.summary.status;
  const blocks = entry?.blocks;
  const takenEdges = entry?.takenEdges;
  const deadEdges = entry?.deadEdges;
  const state = useMemo(
    () => (status && blocks ? { status, blocks, takenEdges: takenEdges ?? [], deadEdges: deadEdges ?? [] } : null),
    [status, blocks, takenEdges, deadEdges]
  );
  const items = useMemo(() => (state && definition ? runTimeline(state, definition, now) : []), [state, definition, now]);
  const overlay = useMemo(() => (state && definition ? deriveRunOverlay(state, definition, now) : null), [state, definition, now]);
  const blockId = pickBlockId(items, picked);
  const actions = useRunActions(api, entry?.summary ?? null, entry?.detail?.triggerPayload, {
    onStarted: (started) => context.selectRun(started)
  });
  const [filter, setFilter] = useState<RunStatusFilter>("all");
  return { api, history, runId, entry, now, definition, items, overlay, blockId, setPicked, actions, filter, setFilter };
}

// ---------------------------------------------------------------------------
// Desktop
// ---------------------------------------------------------------------------

const DesktopRuns: React.FC<WorkflowRunsModeContext> = (context) => {
  const view = useRunsView(context);
  const { history, entry, runId, now, definition, overlay, blockId, actions } = view;

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <aside aria-label="Runs" className="flex w-[288px] shrink-0 flex-col border-r border-neutral-800 bg-neutral-950">
        <div className="flex h-11 shrink-0 items-center gap-2 px-3 text-[13px] font-medium text-neutral-100">
          <History size={14} aria-hidden className="text-neutral-500" />
          Runs
          <span className="text-xs font-normal tabular-nums text-neutral-500">{history.runs.length > 0 ? history.runs.length : ""}</span>
        </div>
        <RunsList
          runs={history.runs}
          selectedRunId={runId}
          onSelect={(id) => context.selectRun(id)}
          filter={view.filter}
          onFilterChange={view.setFilter}
          now={now}
          loading={history.loading}
          error={history.error}
          onRetry={history.retry}
          hasMore={history.hasMore}
          loadingMore={history.loadingMore}
          moreError={history.moreError}
          onLoadMore={history.loadMore}
          className="min-h-0 flex-1 pb-2"
        />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {entry ? (
          <>
            <RunHeader
              run={entry.summary}
              blocks={entry.blocks}
              now={now}
              actions={actions}
              onOpenRun={(id) => context.selectRun(id)}
              className="shrink-0 border-b border-neutral-800 bg-neutral-950"
            />
            <div className="relative min-h-0 flex-1">
              {definition && overlay ? (
                <StandaloneWorkflowCanvas
                  key={runId ?? "none"}
                  workflow={definition}
                  overlay={overlay}
                  readOnly
                  selection={{ nodeIds: blockId ? [blockId] : [], edgeIds: [] }}
                  onSelectionChange={(next) => {
                    if (next.nodeIds.length > 0) view.setPicked(next.nodeIds[next.nodeIds.length - 1]!);
                  }}
                  summaryContext={context.summaryContext}
                  minimap={false}
                />
              ) : (
                <RunLoading entry={entry} />
              )}
              <FrozenNote entry={entry} onEdit={() => context.openEditor(blockId ?? undefined)} />
            </div>
          </>
        ) : (
          <NoRun loading={history.loading} hasRuns={history.runs.length > 0} onEditor={() => context.openEditor()} />
        )}
      </div>

      {entry && blockId ? (
        <aside aria-label="Block run details" className="flex w-[400px] shrink-0 flex-col border-l border-neutral-800 bg-neutral-950">
          <BlockRunDetails
            key={`${entry.summary.id}:${blockId}`}
            api={view.api}
            entry={entry}
            nodeId={blockId}
            now={now}
            onOpenRun={(id) => context.selectRun(id)}
            className="min-h-0 flex-1 overflow-y-auto"
          />
        </aside>
      ) : null}
    </div>
  );
};

/** A small, honest note: this is the definition the run used, not the draft. */
const FrozenNote: React.FC<{ entry: WorkflowRunEntry; onEdit: () => void }> = ({ entry, onEdit }) =>
  entry.detail ? (
    <div className="pointer-events-none absolute left-3 top-3 flex">
      <button
        type="button"
        onClick={onEdit}
        title="The run used the workflow as it was when it started"
        className="pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-lg border border-neutral-800 bg-neutral-900/90 px-2.5 text-xs text-neutral-400 shadow-lg shadow-black/20 backdrop-blur transition-colors hover:text-neutral-100"
      >
        <PencilRuler size={13} aria-hidden />
        As it ran {formatAgo(entry.summary.startedAt ?? entry.summary.queuedAt, Date.now())} · Edit the workflow
      </button>
    </div>
  ) : null;

const RunLoading: React.FC<{ entry: WorkflowRunEntry }> = ({ entry }) => (
  <div className="flex h-full items-center justify-center text-xs text-neutral-500">
    {entry.error ? `Couldn't load the run: ${entry.error}` : "Loading the run…"}
  </div>
);

const NoRun: React.FC<{ loading: boolean; hasRuns: boolean; onEditor: () => void }> = ({ loading, hasRuns, onEditor }) => (
  <div className="flex h-full flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
    <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-neutral-900 text-neutral-400 ring-1 ring-neutral-800">
      <History size={20} aria-hidden />
    </span>
    <div className="text-sm font-medium text-neutral-200">
      {loading ? "Loading runs…" : hasRuns ? "Pick a run to see how it went" : "No runs yet"}
    </div>
    {!loading && !hasRuns ? (
      <p className="max-w-xs text-xs leading-5 text-neutral-500">Run now starts one; an enabled workflow's triggers start the rest.</p>
    ) : null}
    <button
      type="button"
      onClick={onEditor}
      className="mt-1 inline-flex h-9 items-center gap-1.5 rounded-lg border border-neutral-800 px-3 text-xs font-medium text-neutral-300 hover:bg-neutral-900"
    >
      Back to the editor
    </button>
  </div>
);

// ---------------------------------------------------------------------------
// Phone
// ---------------------------------------------------------------------------

const PhoneRuns: React.FC<WorkflowRunsModeContext> = (context) => {
  const view = useRunsView(context);
  const { history, entry, runId, now, definition, overlay, actions } = view;
  const [pane, setPane] = useState<PhoneRunPane>("timeline");
  const [listOpen, setListOpen] = useState(false);
  const [detailsFor, setDetailsFor] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    setDetailsFor(null);
    scroller.current?.scrollTo?.({ top: 0 });
  }, [runId]);

  // A tab that is not shown holds no sheet open (a sheet is portaled over whatever is shown).
  useEffect(() => {
    if (!context.show) {
      setDetailsFor(null);
      setListOpen(false);
    }
  }, [context.show]);

  const openStep = (nodeId: string): void => {
    view.setPicked(nodeId);
    setDetailsFor(nodeId);
  };

  /** "Open session": the sheets close first, or the step sheet would cover the chat it opens. */
  const openSession = (sessionId: string): OpenSessionResult => {
    if (!isWorkflowSessionOpen(sessionId)) return "closed";
    setDetailsFor(null);
    setListOpen(false);
    return focusWorkflowSession(sessionId);
  };
  const detailsName = detailsFor ? (entry?.blocks[detailsFor]?.name ?? definition?.nodes.find((node) => node.id === detailsFor)?.name ?? "Step") : "";
  const summary = entry?.summary ?? null;
  const status = summary ? runStatusView(summary) : null;

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-neutral-800 px-3 py-2">
        <button
          type="button"
          onClick={() => setListOpen(true)}
          className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-xl border border-neutral-800 bg-neutral-900 px-3 text-left active:bg-neutral-800"
          aria-label="All runs"
        >
          {status ? <StatusGlyph icon={status.icon} tone={status.tone} size={15} /> : <History size={15} aria-hidden className="text-neutral-500" />}
          <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-neutral-100">
            {summary ? `${formatAgo(summary.startedAt ?? summary.queuedAt, now) || "now"} · ${status?.label}` : history.loading ? "Loading runs…" : "No runs yet"}
          </span>
          <span className="shrink-0 text-xs tabular-nums text-neutral-500">{history.runs.length > 0 ? `${history.runs.length} runs` : ""}</span>
          <ChevronDown size={15} aria-hidden className="shrink-0 text-neutral-500" />
        </button>
        {entry ? (
          <div role="radiogroup" aria-label="Show the run as" className="flex shrink-0 rounded-xl bg-neutral-900 p-1 ring-1 ring-neutral-800">
            {(
              [
                ["timeline", "Steps", ListTree],
                ["canvas", "Canvas", Network]
              ] as const
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={pane === id}
                aria-label={label}
                onClick={() => setPane(id)}
                className={cn(
                  "flex h-9 w-10 items-center justify-center rounded-lg transition-colors",
                  pane === id ? "bg-neutral-800 text-neutral-50" : "text-neutral-500 active:text-neutral-200"
                )}
              >
                <Icon size={17} aria-hidden />
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {!entry ? (
        <NoRun loading={history.loading} hasRuns={history.runs.length > 0} onEditor={() => context.openEditor()} />
      ) : pane === "canvas" ? (
        <div className="relative min-h-0 flex-1">
          {definition && overlay ? (
            <StandaloneWorkflowCanvas
              key={`${runId}:canvas`}
              workflow={definition}
              overlay={overlay}
              readOnly
              selection={{ nodeIds: view.blockId ? [view.blockId] : [], edgeIds: [] }}
              onSelectionChange={(next) => {
                const id = next.nodeIds[next.nodeIds.length - 1];
                if (id) openStep(id);
              }}
              summaryContext={context.summaryContext}
              minimap={false}
              phone
            />
          ) : (
            <RunLoading entry={entry} />
          )}
        </div>
      ) : (
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-6">
          <RunHeader
            run={entry.summary}
            blocks={entry.blocks}
            now={now}
            actions={actions}
            variant="sheet"
            onOpenInCanvas={() => setPane("canvas")}
            onOpenRun={(id) => context.selectRun(id)}
            className="border-b border-neutral-800"
          />
          <RunTimeline entry={entry} now={now} selectedNodeId={detailsFor} onSelectBlock={openStep} variant="sheet" className="pt-2" />
        </div>
      )}

      <WorkflowSheet
        open={listOpen}
        onClose={() => setListOpen(false)}
        label="Runs"
        title="Runs"
        subtitle={history.runs.length > 0 ? `${history.runs.length}${history.hasMore ? "+" : ""} runs, newest first` : undefined}
        size="full"
        scroll={false}
      >
        <RunsList
          runs={history.runs}
          selectedRunId={runId}
          onSelect={(id) => {
            context.selectRun(id);
            setListOpen(false);
          }}
          filter={view.filter}
          onFilterChange={view.setFilter}
          now={now}
          variant="sheet"
          loading={history.loading}
          error={history.error}
          onRetry={history.retry}
          hasMore={history.hasMore}
          loadingMore={history.loadingMore}
          moreError={history.moreError}
          onLoadMore={history.loadMore}
          className="min-h-0 flex-1 pb-3"
        />
      </WorkflowSheet>

      <WorkflowSheet
        open={entry !== null && detailsFor !== null}
        onClose={() => setDetailsFor(null)}
        label={`${detailsName} — run details`}
        title={null}
        size="full"
      >
        {entry && detailsFor ? (
          <BlockRunDetails
            key={`${entry.summary.id}:${detailsFor}`}
            api={view.api}
            entry={entry}
            nodeId={detailsFor}
            now={now}
            variant="sheet"
            onOpenSession={openSession}
            onOpenRun={(id) => {
              setDetailsFor(null);
              context.selectRun(id);
            }}
            className="px-4 pb-6"
          />
        ) : null}
      </WorkflowSheet>
    </div>
  );
};
