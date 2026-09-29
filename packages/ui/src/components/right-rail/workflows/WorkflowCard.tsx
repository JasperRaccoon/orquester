/**
 * One workflow in the rail: its name and enabled switch, its triggers in
 * words, its last run, a live line while it runs, and Run now / Edit / more.
 * Expanded, it lists its last runs; a run opens the editor on it.
 *
 * Presentational: everything arrives as props (the clock too), so a static
 * render check draws every state without a store. Every control is a real
 * button with a visible label or an accessible name, and on a phone
 * (`variant="sheet"`) every target is at least 40 px — nothing is hover-only.
 */

import React from "react";
import {
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  Clock,
  Copy,
  FlaskConical,
  GitBranch,
  Hand,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  Trash2,
  Workflow as WorkflowIcon
} from "lucide-react";

import type { WorkflowRunSummary, WorkflowSummary, WorkflowTriggerSummary } from "@orquester/api";

import { cn } from "../../../lib/cn";
import {
  formatAgo,
  formatDuration,
  liveRunOf,
  runElapsedMs,
  runProgress,
  runStatusLabel,
  runStatusTone,
  runTriggerText,
  triggerLine,
  type RunTone
} from "../../../lib/workflows/format";
import type { WorkflowRunsList } from "../../../lib/workflows/store";
import { AdaptiveMenu } from "../../ui/adaptive-menu";
import { Button } from "../../ui/button";
import { DropdownItem, DropdownSeparator } from "../../ui/dropdown";
import { Popover } from "../../workflows/ui/Popover";
import { RailChip, RailSwitch, railCardClass } from "../primitives";

export interface WorkflowCardProps {
  workflow: WorkflowSummary;
  variant: "docked" | "sheet";
  /** The clock every relative time and live duration reads. */
  now: number;
  expanded: boolean;
  /** The expanded card's last runs (ignored while collapsed). */
  runs: WorkflowRunsList | null;
  /** A Run now is on its way. */
  starting: boolean;
  /** Why Edit / opening a run cannot work here (no project open), else `null`. */
  editDisabledReason: string | null;
  onToggleExpanded: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onRun: () => void;
  onEdit: () => void;
  onOpenRun: (runId: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onRetryRuns: () => void;
}

const FOCUS_RING = "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500";

/** The dot's paint per tone — the semantic tokens only, so every scheme reads native. */
export const RUN_TONE_DOT: Record<RunTone, string> = {
  ok: "bg-ok",
  danger: "bg-danger",
  warn: "bg-warn",
  info: "bg-info",
  neutral: "bg-neutral-500"
};

const RUN_TONE_TEXT: Record<RunTone, string> = {
  ok: "text-ok",
  danger: "text-danger",
  warn: "text-warn",
  info: "text-info",
  neutral: "text-neutral-400"
};

function TriggerIcon({ trigger }: { trigger: WorkflowTriggerSummary }): React.ReactElement {
  const Icon = trigger.type === "trigger.schedule" ? Clock : trigger.type === "trigger.git" ? GitBranch : Hand;
  return <Icon size={12} aria-hidden className="mt-[3px] shrink-0 text-neutral-500" />;
}

/** A run's status: the dot, then its words. */
export const RunStatusDot: React.FC<{ run: Pick<WorkflowRunSummary, "status">; className?: string }> = ({
  run,
  className
}) => {
  const tone = runStatusTone(run.status);
  const live = run.status === "running";
  return (
    <span aria-hidden className={cn("relative inline-flex h-2 w-2 shrink-0", className)}>
      {live ? (
        <span className={cn("absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping", RUN_TONE_DOT[tone])} />
      ) : null}
      <span className={cn("relative inline-flex h-2 w-2 rounded-full", RUN_TONE_DOT[tone])} />
    </span>
  );
};

/** The thin progress bar under the live line; indeterminate while nothing is known. */
const ProgressBar: React.FC<{ fraction: number | null; label: string }> = ({ fraction, label }) => (
  <div
    role="progressbar"
    aria-label={label}
    aria-valuemin={fraction === null ? undefined : 0}
    aria-valuemax={fraction === null ? undefined : 100}
    aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
    className="h-1 overflow-hidden rounded-full bg-neutral-800"
  >
    {fraction === null ? (
      <div className="h-full w-1/3 rounded-full bg-info/70 motion-safe:animate-pulse" />
    ) : (
      <div
        className="h-full rounded-full bg-info transition-[width] duration-500 motion-reduce:transition-none"
        style={{ width: `${Math.max(4, Math.round(fraction * 100))}%` }}
      />
    )}
  </div>
);

export const WorkflowCard: React.FC<WorkflowCardProps> = (props) => {
  const { workflow, variant, now, expanded } = props;
  const sheet = variant === "sheet";
  const live = liveRunOf(workflow);
  const progress = live ? runProgress(live, now) : null;
  const extraRuns = Math.max(0, workflow.activeRuns.length - 1);
  const last = workflow.lastRun && !live ? workflow.lastRun : null;
  const shownTriggers = workflow.triggers.slice(0, 2);
  const hiddenTriggers = workflow.triggers.length - shownTriggers.length;
  const triggerError = workflow.triggers.find((trigger) => trigger.lastError)?.lastError ?? null;
  const actionHeight = sheet ? "h-10" : "h-7";

  return (
    <article
      data-workflow-card={workflow.id}
      aria-label={workflow.name}
      className={cn(railCardClass(expanded), "overflow-hidden")}
    >
      <div className={cn("space-y-2", sheet ? "p-3" : "px-3 pb-2.5 pt-2.5")}>
        {/* Head: the tile, the name (which expands the card), the switch. */}
        <div className="flex items-start gap-2.5">
          <span
            aria-hidden
            className={cn(
              "mt-0.5 flex shrink-0 items-center justify-center rounded-lg ring-1 transition-colors",
              sheet ? "h-8 w-8" : "h-7 w-7",
              live
                ? "bg-info/10 text-info ring-info/30"
                : workflow.enabled
                  ? "bg-neutral-800/80 text-neutral-200 ring-neutral-700/70"
                  : "bg-neutral-900 text-neutral-500 ring-neutral-800"
            )}
          >
            <WorkflowIcon size={sheet ? 16 : 14} />
          </span>
          <button
            type="button"
            aria-expanded={expanded}
            title={expanded ? "Hide recent runs" : "Show recent runs"}
            onClick={props.onToggleExpanded}
            className={cn("group min-w-0 flex-1 rounded text-left", FOCUS_RING, sheet && "min-h-10")}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className={cn(
                  "truncate text-[13px] font-medium leading-5",
                  workflow.enabled ? "text-neutral-100" : "text-neutral-300"
                )}
              >
                {workflow.name}
              </span>
              <ChevronDown
                size={13}
                aria-hidden
                className={cn(
                  "shrink-0 text-neutral-500 transition-transform group-hover:text-neutral-300 motion-reduce:transition-none",
                  expanded && "rotate-180"
                )}
              />
            </span>
            {workflow.description ? (
              <span className="mt-0.5 block truncate text-xs text-neutral-500">{workflow.description}</span>
            ) : null}
          </button>
          <RailSwitch
            checked={workflow.enabled}
            sheet={sheet}
            label={`Enable ${workflow.name}`}
            title={workflow.enabled ? "Enabled — its triggers fire" : "Disabled — only Run now starts it"}
            onChange={props.onToggleEnabled}
            className={cn("-my-1", sheet ? "-mr-1.5" : "-mr-1")}
          />
        </div>

        {/* Triggers in words. */}
        <ul className={cn("space-y-0.5 text-xs leading-5", workflow.enabled ? "text-neutral-400" : "text-neutral-500")}>
          {shownTriggers.length === 0 ? (
            <li className="flex items-start gap-1.5">
              <Hand size={12} aria-hidden className="mt-[3px] shrink-0 text-neutral-500" />
              <span>Manual only</span>
            </li>
          ) : (
            shownTriggers.map((trigger) => (
              <li key={trigger.nodeId} className="flex min-w-0 items-start gap-1.5">
                <TriggerIcon trigger={trigger} />
                <span className="min-w-0 break-words">
                  {workflow.enabled ? triggerLine(trigger, now) : trigger.text || triggerLine(trigger, now)}
                </span>
              </li>
            ))
          )}
          {hiddenTriggers > 0 ? <li className="pl-[18px] text-neutral-500">+{hiddenTriggers} more</li> : null}
        </ul>

        {triggerError ? (
          <p className="flex items-start gap-1.5 text-xs leading-5 text-warn">
            <AlertTriangle size={12} aria-hidden className="mt-[3px] shrink-0" />
            <span className="line-clamp-2 min-w-0 break-words">{triggerError}</span>
          </p>
        ) : null}

        {/* The last run, or the live line. */}
        {live && progress ? (
          <div className="space-y-1.5 rounded-lg bg-info/5 px-2.5 py-2 ring-1 ring-inset ring-info/20">
            <div className="flex min-w-0 items-center gap-1.5 text-xs text-neutral-200">
              <Play size={11} aria-hidden className="shrink-0 fill-current text-info" />
              <span className="min-w-0 flex-1 truncate">{progress.line}</span>
              {live.test ? <FlaskConical size={12} aria-label="Test run" className="shrink-0 text-neutral-400" /> : null}
              {extraRuns > 0 ? <span className="shrink-0 text-neutral-500">+{extraRuns}</span> : null}
            </div>
            <ProgressBar fraction={progress.fraction} label={`${workflow.name} progress`} />
          </div>
        ) : (
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-neutral-500">
            {last ? (
              <>
                <RunStatusDot run={last} />
                <span className={cn("shrink-0", RUN_TONE_TEXT[runStatusTone(last.status)])}>{runStatusLabel(last)}</span>
                <span aria-hidden>·</span>
                <span className="shrink-0">{formatAgo(last.endedAt ?? last.startedAt ?? last.queuedAt, now) || "—"}</span>
              </>
            ) : (
              <>
                <span aria-hidden className="h-2 w-2 shrink-0 rounded-full border border-neutral-600" />
                <span>Never run</span>
              </>
            )}
            {!workflow.enabled ? <RailChip className="ml-auto text-neutral-400">Off</RailChip> : null}
            {workflow.errorCount > 0 ? (
              <ProblemsChip
                workflow={workflow}
                sheet={sheet}
                editDisabledReason={props.editDisabledReason}
                onEdit={props.onEdit}
                className={cn(workflow.enabled && "ml-auto")}
              />
            ) : null}
          </div>
        )}

        {/* Actions. */}
        <div className="flex items-center gap-1.5 pt-0.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-busy={props.starting ? true : undefined}
            onClick={() => {
              if (!props.starting) props.onRun();
            }}
            className={cn(sheet && "flex-1", actionHeight, props.starting && "opacity-70")}
          >
            {props.starting ? (
              <Loader2 size={13} aria-hidden className="animate-spin" />
            ) : (
              <Play size={12} aria-hidden className="fill-current" />
            )}
            Run now
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={props.editDisabledReason !== null}
            title={props.editDisabledReason ?? "Open the editor"}
            onClick={props.onEdit}
            className={cn(sheet && "flex-1", actionHeight)}
          >
            <Pencil size={12} aria-hidden />
            Edit
          </Button>
          {sheet ? null : <span className="flex-1" />}
          <AdaptiveMenu
            align="right"
            width="w-44"
            title={workflow.name}
            focusOnOpen
            trigger={
              <span
                title="More actions"
                className={cn(
                  "inline-flex items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100",
                  sheet ? "h-10 w-10" : "h-7 w-7"
                )}
              >
                <MoreHorizontal size={15} aria-hidden />
                <span className="sr-only">More actions for {workflow.name}</span>
              </span>
            }
          >
            <DropdownItem icon={<Copy size={14} />} onClick={props.onDuplicate}>
              Duplicate
            </DropdownItem>
            <DropdownSeparator />
            <DropdownItem
              icon={<Trash2 size={14} />}
              onClick={props.onDelete}
              className="text-danger hover:bg-danger-500/10 hover:text-danger"
            >
              Delete
            </DropdownItem>
          </AdaptiveMenu>
        </div>
      </div>

      {expanded ? (
        <RecentRuns
          list={props.runs}
          now={now}
          sheet={sheet}
          disabledReason={props.editDisabledReason}
          onOpenRun={props.onOpenRun}
          onRetry={props.onRetryRuns}
        />
      ) : null}
    </article>
  );
};

/** "1 problem" / "N problems". */
export function problemCountText(count: number): string {
  return count === 1 ? "1 problem" : `${count} problems`;
}

/**
 * What the problems chip says on hover (its `title`) and to a screen reader:
 * each known problem on its own line, then what is left out — or, from a
 * daemon that sends the count alone, the count.
 */
export function problemsHoverText(workflow: Pick<WorkflowSummary, "errorCount" | "errors" | "errorsOmitted">): string {
  const errors = workflow.errors ?? [];
  if (errors.length === 0) return `${problemCountText(workflow.errorCount)} — open the editor to see and fix them before enabling it.`;
  const more = Math.max(workflow.errorsOmitted ?? 0, workflow.errorCount - errors.length);
  return [...errors.map((problem) => problem.message), ...(more > 0 ? [`+${more} more`] : [])].join("\n");
}

/**
 * Whether closing the problems popover gives focus back to its chip: yes when
 * it was dismissed (Esc, the chip, a press outside) and focus went down with
 * the panel (`focusLost`: nothing, or the page body, holds it now) — not when
 * "Open the editor" closed it (the editor takes over), nor when a press
 * outside already put focus somewhere else.
 */
export function returnFocusToProblemsChip(reason: "dismiss" | "edit", focusLost: boolean): boolean {
  return reason === "dismiss" && focusLost;
}

/**
 * The problems chip: hover shows what they are (`title`); a click, tap or
 * Enter opens a small popover listing each one, with the way into the editor.
 * Opening moves focus into it ("Open the editor", else the list); Esc closes
 * it (the Popover's own), and focus comes back to the chip.
 */
const ProblemsChip: React.FC<{
  workflow: WorkflowSummary;
  sheet: boolean;
  editDisabledReason: string | null;
  onEdit: () => void;
  className?: string;
}> = ({ workflow, sheet, editDisabledReason, onEdit, className }) => {
  const [open, setOpen] = React.useState(false);
  const chipRef = React.useRef<HTMLButtonElement | null>(null);
  const editRef = React.useRef<HTMLButtonElement | null>(null);
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const closeReason = React.useRef<"dismiss" | "edit">("dismiss");
  const wasOpen = React.useRef(false);
  const close = React.useCallback((reason: "dismiss" | "edit") => {
    closeReason.current = reason;
    setOpen(false);
  }, []);
  React.useEffect(() => {
    if (open) {
      wasOpen.current = true;
      // The panel is placed (and made visible) in a frame of its own; focus once it shows.
      const frame = requestAnimationFrame(() => {
        const target = editRef.current && !editRef.current.disabled ? editRef.current : listRef.current;
        target?.focus();
      });
      return () => cancelAnimationFrame(frame);
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const active = document.activeElement;
    if (returnFocusToProblemsChip(closeReason.current, active === null || active === document.body)) chipRef.current?.focus();
    closeReason.current = "dismiss";
    return undefined;
  }, [open]);
  const errors = workflow.errors ?? [];
  const more = Math.max(workflow.errorsOmitted ?? 0, workflow.errorCount - errors.length);
  const count = problemCountText(workflow.errorCount);
  return (
    <>
      <button
        ref={chipRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${count} in ${workflow.name} — show them`}
        title={problemsHoverText(workflow)}
        onClick={() => (open ? close("dismiss") : setOpen(true))}
        className={cn(
          "inline-flex max-w-full items-center gap-1 truncate rounded-md border border-danger-900/60 px-1.5 py-px text-[11px] leading-4 text-danger",
          "transition-colors hover:bg-danger-soft/30",
          FOCUS_RING,
          sheet && "min-h-10 px-2.5",
          className
        )}
      >
        <AlertCircle size={11} aria-hidden className="shrink-0" />
        {count}
      </button>
      <Popover
        open={open}
        anchor={{ element: chipRef.current }}
        onClose={() => close("dismiss")}
        ignoreOutside={(target) => chipRef.current?.contains(target) ?? false}
        align="end"
        ariaLabel={`Problems in ${workflow.name}`}
        className="w-[300px] max-w-[calc(100vw-16px)]"
      >
        <div className="border-b border-neutral-800 px-3 py-2">
          <div className="text-[13px] font-medium text-neutral-100">{count}</div>
          <p className="text-[11px] leading-4 text-neutral-500">Fix them in the editor to enable this workflow.</p>
        </div>
        <div ref={listRef} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto p-2 focus:outline-none">
          {errors.length === 0 ? (
            <p className="px-1 py-1 text-[12px] leading-[18px] text-neutral-400">
              The editor lists {workflow.errorCount === 1 ? "it" : "them"} and marks each block in red.
            </p>
          ) : (
            <ul className="space-y-1">
              {errors.map((problem, index) => (
                <li
                  key={`${problem.code}:${problem.nodeId ?? ""}:${problem.field ?? ""}:${index}`}
                  className="flex items-start gap-2 rounded-lg bg-danger-soft/25 px-2.5 py-1.5 text-[12px] leading-[18px] text-danger"
                >
                  <AlertCircle size={13} aria-hidden className="mt-[3px] shrink-0" />
                  <span className="min-w-0 break-words">{problem.message}</span>
                </li>
              ))}
              {more > 0 ? <li className="px-2.5 text-[11px] text-neutral-500">+{more} more in the editor</li> : null}
            </ul>
          )}
        </div>
        <div className="border-t border-neutral-800 p-2">
          <Button
            ref={editRef}
            type="button"
            size="sm"
            variant="outline"
            disabled={editDisabledReason !== null}
            title={editDisabledReason ?? "Open the editor"}
            onClick={() => {
              close("edit");
              onEdit();
            }}
            className={cn("w-full", sheet ? "h-10" : "h-7")}
          >
            <Pencil size={12} aria-hidden />
            Open the editor
          </Button>
        </div>
      </Popover>
    </>
  );
};

/** The expanded card's last runs: status, trigger, when and how long. */
const RecentRuns: React.FC<{
  list: WorkflowRunsList | null;
  now: number;
  sheet: boolean;
  disabledReason: string | null;
  onOpenRun: (runId: string) => void;
  onRetry: () => void;
}> = ({ list, now, sheet, disabledReason, onOpenRun, onRetry }) => {
  const runs = list?.runs ?? [];
  const loading = !list || list.status === "idle" || list.status === "loading";
  return (
    <div className="border-t border-neutral-800/80 bg-neutral-950/30 px-1.5 py-1.5">
      <div className="px-1.5 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
        Recent runs
      </div>
      {runs.length === 0 ? (
        loading ? (
          <p className="flex items-center gap-1.5 px-1.5 py-1.5 text-xs text-neutral-500">
            <Loader2 size={12} aria-hidden className="animate-spin" />
            Loading runs…
          </p>
        ) : list?.status === "error" ? (
          <p className="flex items-center gap-2 px-1.5 py-1.5 text-xs text-neutral-500">
            <span className="min-w-0 flex-1 break-words">{list.error}</span>
            <button type="button" onClick={onRetry} className="shrink-0 rounded px-1 text-neutral-300 hover:underline">
              Retry
            </button>
          </p>
        ) : (
          <p className="px-1.5 py-1.5 text-xs text-neutral-500">No runs yet — Run now starts one.</p>
        )
      ) : (
        <ul className="space-y-px">
          {runs.slice(0, 10).map((run) => {
            const elapsed = runElapsedMs(run, now);
            return (
              <li key={run.id}>
                <button
                  type="button"
                  disabled={disabledReason !== null}
                  title={disabledReason ?? `Open this run (${runStatusLabel(run)})`}
                  onClick={() => onOpenRun(run.id)}
                  className={cn(
                    "flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-xs transition-colors hover:bg-neutral-800/70",
                    "disabled:cursor-not-allowed disabled:hover:bg-transparent",
                    FOCUS_RING,
                    sheet ? "min-h-10" : "min-h-7"
                  )}
                >
                  <RunStatusDot run={run} />
                  <span className="sr-only">{runStatusLabel(run)}:</span>
                  <span className="min-w-0 flex-1 truncate text-neutral-300">
                    {runTriggerText(run)}
                    {run.test ? <span className="text-neutral-500"> · test</span> : null}
                  </span>
                  <span className="shrink-0 tabular-nums text-neutral-500">
                    {formatAgo(run.startedAt ?? run.queuedAt, now)}
                  </span>
                  <span className="w-10 shrink-0 text-right tabular-nums text-neutral-500">
                    {elapsed === null ? "—" : formatDuration(elapsed)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
