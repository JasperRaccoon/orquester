/**
 * The head of a run's view (spec §7.3): its status, what started it, when and
 * for how long (live while it runs), the project it ran in — a temporary one's
 * fate, with "Delete temp project now" — its error, and the run's actions:
 * Cancel run, Retry run, Retry from failed block, Open in canvas.
 *
 * Prop-driven: the actions arrive as a `RunActionsState` (`useRunActions`),
 * so a static render draws every state. Whether the run counts as viewed is
 * the Runs mode's call (`useRunOnScreen`), not this component's: only a
 * finished run, shown, in a visible document.
 */

import React, { useState } from "react";
import {
  Ban,
  FlaskConical,
  FolderGit2,
  FolderX,
  Loader2,
  Network,
  RotateCcw,
  StepForward,
  Trash2,
  X
} from "lucide-react";

import type { WorkflowBlockRun, WorkflowRunSummary } from "@orquester/api";

import { cn } from "../../../lib/cn";
import { runElapsedMs, runTriggerText } from "../../../lib/workflows/format";
import { formatClock, formatStepDuration, runActions, runStatusView } from "../../../lib/workflows/run-view";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import type { RunActionsState } from "./use-run-actions";
import { FOCUS_RING, StatusGlyph, TONE_SOFT, type RunsVariant } from "./shared";

export interface RunHeaderProps {
  run: WorkflowRunSummary;
  /** The run's live block states (for "Retry from failed block"). */
  blocks: Readonly<Record<string, WorkflowBlockRun>>;
  now: number;
  actions: RunActionsState;
  variant?: RunsVariant;
  /** Name the workflow in the title (a view outside its editor tab). */
  showWorkflowName?: boolean;
  /** Show this run on the canvas (the phone's "canvas one tap away"). */
  onOpenInCanvas?: () => void;
  /** Open another run (the one this retried, the parent of a sub-workflow run). */
  onOpenRun?: (runId: string) => void;
  className?: string;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

export const RunHeader: React.FC<RunHeaderProps> = ({
  run,
  blocks,
  now,
  actions,
  variant = "docked",
  showWorkflowName = false,
  onOpenInCanvas,
  onOpenRun,
  className
}) => {
  const sheet = variant === "sheet";
  const view = runStatusView(run);
  const can = runActions(run, blocks);
  const elapsed = runElapsedMs(run, now);
  const [confirm, setConfirm] = useState<"cancel" | "delete-temp" | null>(null);

  const started = run.startedAt ?? run.queuedAt;
  const buttonHeight = sheet ? "h-10" : "h-7";
  const button = (primary = false, danger = false) =>
    cn(
      "inline-flex items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
      FOCUS_RING,
      buttonHeight,
      sheet && "flex-1 basis-[calc(50%-0.25rem)]",
      danger
        ? "border border-danger-500/40 text-danger hover:bg-danger-500/10"
        : primary
          ? "bg-neutral-200 text-neutral-900 hover:bg-neutral-50"
          : "border border-neutral-700 text-neutral-200 hover:bg-neutral-800"
    );
  const spinner = <Loader2 size={13} aria-hidden className="animate-spin" />;

  return (
    <header className={cn("space-y-2.5", sheet ? "px-3 py-3" : "px-3 py-2.5", className)}>
      <div className="flex min-w-0 items-start gap-2.5">
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
            TONE_SOFT[view.tone]
          )}
        >
          <StatusGlyph icon={view.icon} tone={view.tone} size={13} />
          {view.label}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium leading-5 text-neutral-100">
            <span className="truncate">{showWorkflowName ? run.workflowName : runTriggerText(run)}</span>
            {run.test ? (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-neutral-700/80 px-1.5 text-[11px] font-normal text-neutral-400">
                <FlaskConical size={11} aria-hidden />
                Test
              </span>
            ) : null}
          </h3>
          <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs leading-5 text-neutral-500">
            {showWorkflowName ? (
              <>
                <span className="truncate">{runTriggerText(run)}</span>
                <span aria-hidden>·</span>
              </>
            ) : null}
            <span title={started}>
              {run.startedAt ? "Started" : "Queued"} {formatClock(started, now)}
            </span>
            {elapsed !== null ? (
              <>
                <span aria-hidden>·</span>
                <span className={cn("tabular-nums", view.live && "text-neutral-300")}>
                  {formatStepDuration(elapsed)}
                </span>
              </>
            ) : null}
            <span aria-hidden>·</span>
            <span className="font-mono text-[11px]" title={run.id}>
              #{run.id.slice(0, 8)}
            </span>
          </p>
        </div>
      </div>

      {run.current && view.live ? (
        <p className="flex min-w-0 items-center gap-1.5 text-xs text-neutral-300">
          <StepForward size={12} aria-hidden className="shrink-0 text-info" />
          <span className="truncate">
            Step {Math.min(Math.max(run.current.index, 1), run.current.total)}/{run.current.total} · {run.current.name}
          </span>
        </p>
      ) : null}

      <ProjectLine
        run={run}
        now={now}
        sheet={sheet}
        busy={actions.busy === "delete-temp"}
        onDelete={() => setConfirm("delete-temp")}
        canDelete={can.deleteTempProject}
      />

      {run.retryOf || run.parentRunId ? (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
          {run.retryOf ? <LinkToRun label="Retry of" runId={run.retryOf} onOpenRun={onOpenRun} sheet={sheet} /> : null}
          {run.parentRunId ? (
            <LinkToRun label="Started by run" runId={run.parentRunId} onOpenRun={onOpenRun} sheet={sheet} />
          ) : null}
        </p>
      ) : null}

      {run.error ? (
        <p className="rounded-lg border border-danger-500/30 bg-danger-500/5 px-2.5 py-2 text-xs leading-5 text-danger">
          <span className="line-clamp-4 break-words">{run.error}</span>
        </p>
      ) : null}

      {actions.error ? (
        <p className="flex items-start gap-2 rounded-lg border border-danger-500/30 px-2.5 py-1.5 text-xs text-danger">
          <span className="min-w-0 flex-1 break-words">{actions.error}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={actions.dismissError}
            className={cn(
              "-m-1 inline-flex shrink-0 items-center justify-center rounded text-danger/80 hover:bg-danger-500/10",
              FOCUS_RING,
              sheet ? "h-10 w-10" : "h-6 w-6"
            )}
          >
            <X size={13} aria-hidden />
          </button>
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {can.cancel ? (
          <button
            type="button"
            className={button(false, true)}
            disabled={actions.busy !== null}
            onClick={() => setConfirm("cancel")}
          >
            {actions.busy === "cancel" ? spinner : <Ban size={13} aria-hidden />}
            Cancel run
          </button>
        ) : null}
        {can.retryFromFailed ? (
          <button
            type="button"
            className={button(true)}
            disabled={actions.busy !== null}
            onClick={actions.retryFromFailed}
          >
            {actions.busy === "retry-failed" ? spinner : <StepForward size={13} aria-hidden />}
            Retry from failed block
          </button>
        ) : null}
        {can.retry ? (
          <button
            type="button"
            className={button(!can.retryFromFailed)}
            disabled={actions.busy !== null}
            onClick={actions.retry}
          >
            {actions.busy === "retry" ? spinner : <RotateCcw size={13} aria-hidden />}
            Retry run
          </button>
        ) : null}
        {onOpenInCanvas ? (
          <button type="button" className={button()} onClick={onOpenInCanvas}>
            <Network size={13} aria-hidden />
            Open in canvas
          </button>
        ) : null}
      </div>

      {confirm === "cancel" ? (
        <ConfirmDialog
          open
          title="Cancel this run?"
          message="Its running blocks stop now — agents are interrupted and processes killed. Blocks that finished keep their results."
          confirmLabel="Cancel run"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            actions.cancel();
          }}
        />
      ) : null}
      {confirm === "delete-temp" ? (
        <ConfirmDialog
          open
          title="Delete the temporary project?"
          message={
            <>
              <span className="break-all font-mono text-xs text-neutral-300">{run.tempProject?.path}</span> and
              everything the run left in it are deleted now, instead of when it expires.
            </>
          }
          confirmLabel="Delete now"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            actions.deleteTempProject();
          }}
        />
      ) : null}
    </header>
  );
};

const ProjectLine: React.FC<{
  run: WorkflowRunSummary;
  now: number;
  sheet: boolean;
  canDelete: boolean;
  busy: boolean;
  onDelete: () => void;
}> = ({ run, now, sheet, canDelete, busy, onDelete }) => {
  const temp = run.tempProject;
  if (!temp && !run.projectPath) return null;
  if (!temp) {
    return (
      <p className="flex min-w-0 items-center gap-1.5 text-xs text-neutral-400" title={run.projectPath}>
        <FolderGit2 size={12} aria-hidden className="shrink-0 text-neutral-500" />
        <span className="truncate">{basename(run.projectPath!)}</span>
      </p>
    );
  }
  const expires = temp.deleteAfter ? formatClock(temp.deleteAfter, now) : "";
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span className="flex min-w-0 items-center gap-1.5 text-neutral-400" title={temp.path}>
        {temp.deleted ? (
          <FolderX size={12} aria-hidden className="shrink-0 text-neutral-500" />
        ) : (
          <FolderGit2 size={12} aria-hidden className="shrink-0 text-neutral-500" />
        )}
        <span className="truncate">
          Temporary project{" "}
          <span className="text-neutral-500">
            · {temp.deleted ? "deleted" : expires ? `kept until ${expires}` : basename(temp.path)}
          </span>
        </span>
      </span>
      {canDelete ? (
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          className={cn(
            "inline-flex items-center gap-1 rounded-md px-1.5 text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-danger disabled:opacity-60",
            FOCUS_RING,
            sheet ? "h-10 px-2" : "h-6"
          )}
        >
          {busy ? <Loader2 size={12} aria-hidden className="animate-spin" /> : <Trash2 size={12} aria-hidden />}
          Delete temp project now
        </button>
      ) : null}
    </div>
  );
};

const LinkToRun: React.FC<{
  label: string;
  runId: string;
  sheet: boolean;
  onOpenRun?: (runId: string) => void;
}> = ({ label, runId, sheet, onOpenRun }) =>
  onOpenRun ? (
    <button
      type="button"
      onClick={() => onOpenRun(runId)}
      className={cn(
        "inline-flex items-center gap-1 rounded text-neutral-400 hover:text-neutral-100 hover:underline",
        FOCUS_RING,
        sheet && "min-h-10"
      )}
    >
      {label} <span className="font-mono">#{runId.slice(0, 8)}</span>
    </button>
  ) : (
    <span>
      {label} <span className="font-mono">#{runId.slice(0, 8)}</span>
    </span>
  );
