/**
 * A roster task's own Stop (`/task/stop`, `taskStopControl`): a workflow run's,
 * a subagent's or a background shell's. "Stopping…" — and disabled — from the
 * click until the task settles, when `taskStopControl` hides it. Always
 * visible, never on hover only: a touch screen has no hover.
 */

import React from "react";
import { cn } from "../../../lib/cn";
import type { TaskStopControl } from "../../../lib/agent-chat/roster.logic";

export interface TaskStop {
  control: Exclude<TaskStopControl, "hidden">;
  onStop: () => void;
}

/** The Stop a `taskStopControl` asks for, or null where it shows none. */
export function taskStop(
  control: TaskStopControl,
  taskId: string,
  onStopTask: ((taskId: string) => void) | undefined
): TaskStop | null {
  if (control === "hidden" || onStopTask === undefined) return null;
  return { control, onStop: () => onStopTask(taskId) };
}

export function TaskStopButton({
  label,
  title,
  stop,
  className
}: {
  /** The task's name, for the accessible label: "Stop <label>". */
  label: string;
  /** The tooltip while it is offered; "Stopping <label>" once clicked. */
  title?: string;
  stop: TaskStop;
  className?: string;
}): React.ReactElement {
  const stopping = stop.control === "stopping";
  return (
    <button
      type="button"
      disabled={stopping}
      onClick={(event) => {
        // Rows open their agent on click: a Stop never does.
        event.stopPropagation();
        stop.onStop();
      }}
      aria-label={stopping ? `Stopping ${label}` : `Stop ${label}`}
      title={stopping ? `Stopping ${label}` : (title ?? `Stop ${label}`)}
      className={cn(
        "ac-press inline-flex h-5 shrink-0 items-center rounded px-1.5 font-mono text-[10px] font-medium normal-case tracking-normal",
        "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100",
        "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
        "disabled:pointer-events-none disabled:opacity-50",
        className
      )}
    >
      {stopping ? "Stopping…" : "Stop"}
    </button>
  );
}
