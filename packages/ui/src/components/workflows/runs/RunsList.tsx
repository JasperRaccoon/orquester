/**
 * A workflow's runs (spec §7.3's runs list): status, trigger, when it started
 * and how long it took, a flask on test runs, skipped fires muted with their
 * reason; status filter chips over the loaded runs; "Load more" pages back
 * with the `before` cursor; a selected row.
 *
 * The Runs mode supplies the rows, paging state and shared clock. On a phone
 * (`variant="sheet"`) every row and chip is ≥ 40 px.
 */

import React, { useMemo } from "react";
import { FlaskConical, Loader2, RotateCcw } from "lucide-react";

import type { WorkflowRunSummary } from "@orquester/api";

import { cn } from "../../../lib/cn";
import { formatAgo, formatDuration, runElapsedMs, runTriggerText } from "../../../lib/workflows/format";
import {
  filterRuns,
  RUN_STATUS_FILTERS,
  runFilterCounts,
  runOutcomeText,
  runStatusView,
  type RunStatusFilter
} from "../../../lib/workflows/run-view";
import { FOCUS_RING, StatusGlyph, TONE_TEXT, type RunsVariant } from "./shared";

export interface RunsListProps {
  runs: readonly WorkflowRunSummary[];
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
  filter: RunStatusFilter;
  onFilterChange: (filter: RunStatusFilter) => void;
  /** The clock relative times and live durations read. */
  now: number;
  variant?: RunsVariant;
  /** The first page is on its way. */
  loading?: boolean;
  /** The first page failed. */
  error?: string | null;
  onRetry?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  moreError?: string | null;
  onLoadMore?: () => void;
  className?: string;
}

export const RunsList: React.FC<RunsListProps> = ({
  runs,
  selectedRunId,
  onSelect,
  filter,
  onFilterChange,
  now,
  variant = "docked",
  loading = false,
  error = null,
  onRetry,
  hasMore = false,
  loadingMore = false,
  moreError = null,
  onLoadMore,
  className
}) => {
  const sheet = variant === "sheet";
  const counts = useMemo(() => runFilterCounts(runs), [runs]);
  const shown = useMemo(() => filterRuns(runs, filter), [runs, filter]);
  // Chips with nothing behind them stay out of the way (the active one always shows).
  const chips = RUN_STATUS_FILTERS.filter(
    (option) => option.id === "all" || option.id === filter || counts[option.id] > 0
  );

  return (
    <section aria-label="Runs" className={cn("flex min-h-0 flex-col", className)}>
      <div
        role="group"
        aria-label="Filter runs by status"
        className={cn("flex shrink-0 gap-1 overflow-x-auto pb-2", sheet ? "px-3" : "px-2")}
      >
        {chips.map((option) => {
          const active = option.id === filter;
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={active}
              onClick={() => onFilterChange(option.id)}
              className={cn(
                "inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 text-xs transition-colors",
                FOCUS_RING,
                sheet ? "h-10 px-3.5" : "h-7",
                active
                  ? "border-neutral-600 bg-neutral-800 text-neutral-50"
                  : "border-neutral-800 text-neutral-400 hover:border-neutral-700 hover:text-neutral-200"
              )}
            >
              {option.label}
              <span className={cn("tabular-nums", active ? "text-neutral-400" : "text-neutral-600")}>
                {counts[option.id]}
              </span>
            </button>
          );
        })}
      </div>

      <div className={cn("min-h-0 flex-1 overflow-y-auto", sheet ? "px-2" : "px-1")}>
        {shown.length === 0 ? (
          loading ? (
            <p className="flex items-center gap-2 px-2 py-3 text-xs text-neutral-500">
              <Loader2 size={13} aria-hidden className="animate-spin" />
              Loading runs…
            </p>
          ) : error ? (
            <div className="flex items-center gap-2 px-2 py-3 text-xs text-neutral-500">
              <span className="min-w-0 flex-1 break-words">{error}</span>
              {onRetry ? (
                <button
                  type="button"
                  onClick={onRetry}
                  className={cn(
                    "shrink-0 rounded px-2 text-neutral-300 hover:bg-neutral-800",
                    FOCUS_RING,
                    sheet ? "h-10" : "h-7"
                  )}
                >
                  Retry
                </button>
              ) : null}
            </div>
          ) : (
            <p className="px-2 py-3 text-xs text-neutral-500">
              {runs.length === 0 ? "No runs yet — Run now starts one." : "No runs match this filter."}
            </p>
          )
        ) : (
          <ul className="space-y-px">
            {shown.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                now={now}
                sheet={sheet}
                selected={run.id === selectedRunId}
                onSelect={onSelect}
              />
            ))}
          </ul>
        )}

        {hasMore || moreError ? (
          <div className="px-1 py-2">
            {moreError ? <p className="px-1 pb-1.5 text-xs text-danger">{moreError}</p> : null}
            <button
              type="button"
              onClick={onLoadMore}
              disabled={loadingMore || !onLoadMore}
              className={cn(
                "flex w-full items-center justify-center gap-1.5 rounded-lg border border-neutral-800 text-xs text-neutral-300 transition-colors hover:bg-neutral-800/70 disabled:opacity-60",
                FOCUS_RING,
                sheet ? "h-10" : "h-8"
              )}
            >
              {loadingMore ? (
                <Loader2 size={13} aria-hidden className="animate-spin" />
              ) : moreError ? (
                <RotateCcw size={12} aria-hidden />
              ) : null}
              {loadingMore ? "Loading older runs…" : moreError ? "Try again" : "Load more"}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
};

const RunRow: React.FC<{
  run: WorkflowRunSummary;
  now: number;
  sheet: boolean;
  selected: boolean;
  onSelect: (runId: string) => void;
}> = ({ run, now, sheet, selected, onSelect }) => {
  const view = runStatusView(run);
  const skipped = run.status === "skipped";
  const elapsed = runElapsedMs(run, now);
  const started = formatAgo(run.startedAt ?? run.queuedAt, now);
  return (
    <li>
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(run.id)}
        title={runOutcomeText(run, now)}
        className={cn(
          "group flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2 text-left transition-colors",
          FOCUS_RING,
          sheet ? "min-h-12 py-1.5" : "min-h-9 py-1",
          selected ? "bg-neutral-800 ring-1 ring-inset ring-neutral-700" : "hover:bg-neutral-800/50",
          skipped && !selected && "opacity-60"
        )}
      >
        <StatusGlyph icon={view.icon} tone={view.tone} size={sheet ? 16 : 14} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className={cn("truncate text-[13px] leading-5", skipped ? "text-neutral-400" : "text-neutral-200")}>
              {runTriggerText(run)}
            </span>
            {run.test ? <FlaskConical size={12} aria-label="Test run" className="shrink-0 text-neutral-400" /> : null}
          </span>
          <span className="flex min-w-0 items-center gap-1 text-[11px] leading-4 text-neutral-500">
            {skipped ? (
              <span className="truncate">{runOutcomeText(run, now)}</span>
            ) : (
              <span className={cn("shrink-0", TONE_TEXT[view.tone])}>{view.label}</span>
            )}
            {started ? <span className="shrink-0">· {started}</span> : null}
          </span>
        </span>
        <span className="w-12 shrink-0 text-right text-xs tabular-nums text-neutral-500">
          {skipped || elapsed === null ? "—" : formatDuration(elapsed)}
        </span>
      </button>
    </li>
  );
};
