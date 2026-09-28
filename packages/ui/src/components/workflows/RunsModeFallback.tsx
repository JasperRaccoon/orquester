/**
 * The editor tab's Runs mode when no richer run view is plugged in: the
 * workflow's runs (newest first, live), and the selected run's frozen
 * definition drawn read-only under its overlay — which blocks ran, how they
 * ended, which edges the run took. The runs builder's view replaces this
 * through `WorkflowEditorTab`'s `renderRunsMode` (or `registerWorkflowRunsMode`).
 */

import React, { useEffect, useMemo, useState } from "react";
import { FlaskConical, History, Loader2 } from "lucide-react";

import { isRunActive } from "@orquester/api";

import { cn } from "../../lib/cn";
import type { NodeSummaryContext } from "../../lib/workflows/catalog-ui";
import { formatAgo, formatDuration, runElapsedMs, runStatusLabel, runStatusTone, runTriggerText } from "../../lib/workflows/format";
import { useWorkflowRun, useWorkflowRuns } from "../../lib/workflows/hooks";
import { deriveRunOverlay } from "../../lib/workflows/overlay";
import { RunStatusDot } from "../right-rail/workflows/WorkflowCard";
import { StandaloneWorkflowCanvas } from "./canvas/WorkflowCanvas";
import { useRunOnScreen } from "./runs/use-run-on-screen";

const TONE_TEXT = { ok: "text-ok", danger: "text-danger", warn: "text-warn", info: "text-info", neutral: "text-neutral-400" } as const;

function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export const RunsModeFallback: React.FC<{
  workflowId: string;
  runId: string | null;
  onSelectRun: (runId: string | null) => void;
  summaryContext: NodeSummaryContext;
  show?: boolean;
}> = ({ workflowId, runId, onSelectRun, summaryContext, show = true }) => {
  const list = useWorkflowRuns(workflowId);
  const selectedId = runId ?? list.runs[0]?.id ?? null;
  const entry = useWorkflowRun(selectedId);
  useRunOnScreen(entry ? selectedId : null, show, entry !== null && !isRunActive(entry.summary.status));
  const anyLive = list.runs.some((run) => isRunActive(run.status));
  const now = useTicker(anyLive);
  const [selection, setSelection] = useState<{ nodeIds: string[]; edgeIds: string[] }>({ nodeIds: [], edgeIds: [] });

  const definition = entry?.detail?.definition ?? null;
  const overlay = useMemo(
    () =>
      entry && definition
        ? deriveRunOverlay(
            { status: entry.summary.status, blocks: entry.blocks, takenEdges: entry.takenEdges, deadEdges: entry.deadEdges },
            definition,
            now
          )
        : null,
    [entry, definition, now]
  );

  return (
    <div className="flex min-h-0 flex-1">
      <aside aria-label="Runs" className="flex w-72 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-neutral-800 px-3 text-[13px] font-medium text-neutral-100">
          <History size={14} className="text-neutral-500" />
          Runs
          {list.refreshing ? <Loader2 size={12} className="ml-auto text-neutral-500 motion-safe:animate-spin" /> : null}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {list.status === "loading" && list.runs.length === 0 ? (
            <p className="px-2 py-4 text-xs text-neutral-500">Loading runs…</p>
          ) : list.runs.length === 0 ? (
            <p className="px-2 py-4 text-xs leading-5 text-neutral-500">No runs yet. Use Run now, or wait for a trigger.</p>
          ) : (
            list.runs.map((run) => {
              const elapsed = runElapsedMs(run, now);
              const tone = runStatusTone(run.status);
              return (
                <button
                  key={run.id}
                  type="button"
                  aria-pressed={run.id === selectedId}
                  onClick={() => onSelectRun(run.id)}
                  className={cn(
                    "mb-0.5 flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                    run.id === selectedId ? "bg-neutral-800/80" : "hover:bg-neutral-900"
                  )}
                >
                  <span className="flex items-center gap-2">
                    <RunStatusDot run={run} />
                    <span className={cn("text-[12.5px] font-medium", TONE_TEXT[tone])}>{runStatusLabel(run)}</span>
                    {run.test ? <FlaskConical size={11} className="text-neutral-500" aria-label="Test run" /> : null}
                    <span className="ml-auto text-[11px] tabular-nums text-neutral-500">
                      {elapsed !== null ? formatDuration(elapsed) : ""}
                    </span>
                  </span>
                  <span className="flex items-center gap-2 pl-4 text-[11px] text-neutral-500">
                    <span className="min-w-0 flex-1 truncate">{runTriggerText(run)}</span>
                    <span className="shrink-0">{formatAgo(run.startedAt ?? run.queuedAt, now)}</span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </aside>
      <div className="relative min-w-0 flex-1">
        {definition && overlay ? (
          <StandaloneWorkflowCanvas
            key={selectedId ?? "none"}
            workflow={definition}
            overlay={overlay}
            readOnly
            selection={selection}
            onSelectionChange={(next) => setSelection({ nodeIds: [...next.nodeIds], edgeIds: [...next.edgeIds] })}
            summaryContext={summaryContext}
            minimap={false}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-neutral-500">
            {selectedId ? (entry?.error ? `Couldn't load the run: ${entry.error}` : "Loading the run…") : "Pick a run to see how it went."}
          </div>
        )}
        {entry?.summary.error ? (
          <div className="pointer-events-none absolute inset-x-4 top-3 flex justify-center">
            <div className="pointer-events-auto max-w-xl rounded-lg border border-danger/40 bg-neutral-900/95 px-3 py-2 text-[12px] text-danger shadow-lg shadow-black/30">
              {entry.summary.error}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};
