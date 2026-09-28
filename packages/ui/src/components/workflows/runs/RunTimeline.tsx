/**
 * A run as a vertical timeline of its steps (spec §7.4 — the phone's run
 * view, and a compact desktop one): each step's live state, its duration
 * (ticking while it runs), the agent's account and hop count, its error or
 * why it was skipped; branches indented under their handle ("on failure",
 * "true", "case 1"), a join once after its branches. Tap a step to open it.
 */

import React, { useEffect, useMemo } from "react";
import { CornerDownRight, FlaskConical, Pin, Repeat2 } from "lucide-react";

import type { WorkflowRunEntry } from "../../../lib/workflows/store";
import { cn } from "../../../lib/cn";
import { markWorkflowRunViewed } from "../../../lib/workflows/notifications";
import {
  blockErrorKindLabel,
  blockTypeLabel,
  formatStepDuration,
  runTimeline,
  type TimelineItem
} from "../../../lib/workflows/run-view";
import { FOCUS_RING, StatusGlyph, TONE_TEXT, type RunsVariant } from "./shared";

export interface RunTimelineProps {
  /** The run as the store holds it (`useWorkflowRun`): its frozen definition and live blocks. */
  entry: WorkflowRunEntry;
  now: number;
  selectedNodeId: string | null;
  onSelectBlock: (nodeId: string) => void;
  variant?: RunsVariant;
  className?: string;
}

export const RunTimeline: React.FC<RunTimelineProps> = ({
  entry,
  now,
  selectedNodeId,
  onSelectBlock,
  variant = "docked",
  className
}) => {
  const sheet = variant === "sheet";
  const definition = entry.detail?.definition ?? null;
  const items = useMemo(
    () =>
      definition
        ? runTimeline(
            {
              status: entry.summary.status,
              blocks: entry.blocks,
              takenEdges: entry.takenEdges,
              deadEdges: entry.deadEdges
            },
            definition,
            now
          )
        : [],
    [definition, entry.summary.status, entry.blocks, entry.takenEdges, entry.deadEdges, now]
  );

  useEffect(() => {
    markWorkflowRunViewed(entry.summary.id);
  }, [entry.summary.id]);

  if (!definition) {
    return (
      <div className={cn("space-y-2 p-3", className)} aria-busy="true" aria-label="Loading the run">
        {entry.error ? (
          <p className="text-xs text-danger">{entry.error}</p>
        ) : (
          [0, 1, 2, 3].map((index) => (
            <div key={index} className="flex items-center gap-3">
              <span className="h-5 w-5 shrink-0 rounded-full bg-neutral-800 motion-safe:animate-pulse" />
              <span
                className="h-3 flex-1 rounded bg-neutral-800/80 motion-safe:animate-pulse"
                style={{ maxWidth: `${70 - index * 10}%` }}
              />
            </div>
          ))
        )}
      </div>
    );
  }

  return (
    <ol aria-label="Steps" className={cn("relative py-1", sheet ? "px-2" : "px-1", className)}>
      {items.map((item, index) => (
        <TimelineRow
          key={item.key}
          item={item}
          last={index === items.length - 1}
          sheet={sheet}
          selected={item.kind === "step" && item.nodeId === selectedNodeId}
          onSelect={onSelectBlock}
        />
      ))}
    </ol>
  );
};

const INDENT = 18;

const TimelineRow: React.FC<{
  item: TimelineItem;
  last: boolean;
  sheet: boolean;
  selected: boolean;
  onSelect: (nodeId: string) => void;
}> = ({ item, last, sheet, selected, onSelect }) => {
  const indent = item.depth * INDENT;
  if (item.kind === "join-ref") {
    return (
      <li className="relative" style={{ paddingLeft: indent }}>
        {item.branchLabel ? <BranchLabel label={item.branchLabel} /> : null}
        <button
          type="button"
          onClick={() => onSelect(item.nodeId)}
          className={cn(
            "flex w-full items-center gap-2 rounded-md pl-[7px] pr-2 text-left text-xs text-neutral-500 hover:bg-neutral-800/40 hover:text-neutral-300",
            FOCUS_RING,
            sheet ? "min-h-10" : "min-h-7"
          )}
        >
          <CornerDownRight size={13} aria-hidden className="shrink-0" />
          <span className="truncate">continues at {item.name}</span>
        </button>
      </li>
    );
  }

  const muted = item.status === "skipped" || item.status === "pending";
  const duration = formatStepDuration(item.durationMs);
  const meta: string[] = [];
  meta.push(blockTypeLabel(item.type));
  if (item.account) meta.push(item.account);
  if (item.attempt > 1) meta.push(`attempt ${item.attempt}`);
  if (item.finishedOn) meta.push(`→ ${item.finishedOn}`);

  return (
    <li className="relative" style={{ paddingLeft: indent }}>
      {item.branchLabel ? <BranchLabel label={item.branchLabel} /> : null}
      <div className="relative">
        {/* The rail: a line from this step's glyph down to the next. */}
        {!last ? (
          <span
            aria-hidden
            className={cn("absolute bottom-0 w-px bg-neutral-800", sheet ? "left-[19px] top-9" : "left-[15px] top-8")}
          />
        ) : null}
        <button
          type="button"
          aria-current={selected ? "step" : undefined}
          onClick={() => onSelect(item.nodeId)}
          title={item.view.label}
          className={cn(
            "relative flex w-full min-w-0 items-start gap-2.5 rounded-lg px-2 text-left transition-colors",
            FOCUS_RING,
            sheet ? "min-h-14 py-2.5" : "min-h-11 py-2",
            selected ? "bg-neutral-800/90 ring-1 ring-inset ring-neutral-700" : "hover:bg-neutral-800/40"
          )}
        >
          <span
            className={cn(
              "relative z-[1] mt-px flex shrink-0 items-center justify-center rounded-full bg-neutral-950 ring-1",
              sheet ? "h-6 w-6" : "h-5 w-5",
              item.view.live ? "ring-info/40" : item.status === "failed" ? "ring-danger/40" : "ring-neutral-800"
            )}
          >
            <StatusGlyph icon={item.view.icon} tone={item.view.tone} size={sheet ? 15 : 13} />
            {item.view.live ? (
              <span
                aria-hidden
                className="absolute inset-0 rounded-full ring-2 ring-info/30 motion-safe:animate-pulse"
              />
            ) : null}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-baseline gap-2">
              <span
                className={cn(
                  "min-w-0 truncate text-[13px] font-medium leading-5",
                  muted ? "text-neutral-500" : "text-neutral-100",
                  item.disabled && "line-through decoration-neutral-600"
                )}
              >
                {item.name}
              </span>
              {item.hopCount > 0 ? (
                <span
                  title={item.hopsSummary}
                  className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-warn/30 bg-warn/5 px-1.5 text-[10px] leading-4 text-warn"
                >
                  <Repeat2 size={10} aria-hidden />
                  {item.hopCount === 1 ? "1 hop" : `${item.hopCount} hops`}
                </span>
              ) : null}
              {item.pinned ? (
                <span title="Pinned output (test run)" className="inline-flex shrink-0 items-center text-neutral-500">
                  <Pin size={11} aria-hidden />
                  <FlaskConical size={11} aria-hidden />
                </span>
              ) : null}
              <span
                className={cn(
                  "ml-auto shrink-0 text-xs tabular-nums",
                  item.view.live ? TONE_TEXT[item.view.tone] : "text-neutral-500"
                )}
              >
                {duration || (item.notReached ? "" : item.view.live ? item.view.label : "")}
              </span>
            </span>
            <span
              className={cn("block truncate text-[11px] leading-4", muted ? "text-neutral-600" : "text-neutral-500")}
            >
              {meta.join(" · ")}
            </span>
            {item.liveLine ? (
              <span className="mt-0.5 block truncate text-xs leading-5 text-neutral-300">{item.liveLine}</span>
            ) : null}
            {item.error ? (
              <span className="mt-0.5 block text-xs leading-5 text-danger">
                <span className="line-clamp-2 break-words">
                  {item.errorKind ? <span className="font-medium">{blockErrorKindLabel(item.errorKind)}: </span> : null}
                  {item.error}
                </span>
              </span>
            ) : null}
            {item.skippedReason && item.status === "skipped" ? (
              <span className="mt-0.5 block truncate text-[11px] italic leading-4 text-neutral-600">
                {item.skippedReason}
              </span>
            ) : null}
          </span>
        </button>
      </div>
    </li>
  );
};

const BranchLabel: React.FC<{ label: string }> = ({ label }) => (
  <div className="flex items-center gap-1.5 pb-0.5 pl-2 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
    <span aria-hidden className="h-px w-2.5 bg-neutral-700" />
    on {label}
  </div>
);
