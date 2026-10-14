/**
 * The scheduled-tasks chip and its popover (design 2026-10-14 §5 "Scheduling").
 *
 * The least intrusive surface for a thread's scheduled prompts: nothing at all until the thread
 * has a task, then a compact `2 scheduled` readout in the status line beside the goal chip. Click
 * opens a dialog (not a menu — rows of text with plain buttons) listing each task: its prompt, its
 * schedule, what happens next, and Run now / Cancel. Cancel asks once more on the same button,
 * since an agent may have set the task up for the user. The pure half is `scheduled-tasks-chip.ts`.
 */

import React from "react";
import { CalendarClock } from "lucide-react";

import { cn } from "../../../lib/cn";
import { dismissWhenChatTabLeaves } from "../../../lib/agent-chat-active-tab";
import { useApi } from "../../../context/orquester-context";
import { useThreadScheduledTasks } from "../../../lib/scheduled-tasks/hooks";
import { cancelScheduledTask, runScheduledTaskNow } from "../../../lib/scheduled-tasks/store";
import { Button } from "../../ui/button";
import { Dropdown } from "../../ui/dropdown";
import { DROPDOWN_DESTRUCTIVE_ATTRIBUTE } from "../../ui/dropdown-logic";
import {
  deriveScheduledChip,
  deriveScheduledTaskRow,
  sortScheduledTasks,
  type ScheduledChipTone
} from "./scheduled-tasks-chip";

const TONE: Record<ScheduledChipTone, string> = {
  neutral: "text-neutral-500",
  info: "text-info-300",
  warn: "text-warn-300"
};

const TRIGGER_CLASS =
  "min-w-0 shrink-0 rounded-md focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500";

export function ScheduledTasksChip({ sessionId }: { sessionId: string }): React.ReactElement | null {
  const api = useApi();
  const { tasks, busy, notice } = useThreadScheduledTasks(sessionId);
  const dismissOn = React.useMemo(() => dismissWhenChatTabLeaves(sessionId), [sessionId]);
  const [confirming, setConfirming] = React.useState<string | null>(null);
  const now = new Date();
  const chip = deriveScheduledChip(tasks, now);
  if (chip === null) return null;
  const rows = sortScheduledTasks(tasks);

  return (
    <Dropdown
      align="right"
      width="w-80"
      className="p-0"
      triggerClassName={TRIGGER_CLASS}
      role="dialog"
      ariaLabel="Scheduled tasks"
      focusOnOpen
      dismissOn={dismissOn}
      trigger={
        <span
          title={chip.title}
          className={cn("ac-press inline-flex h-6 items-center gap-1 rounded-md px-1 font-mono hover:bg-neutral-800", TONE[chip.tone])}
        >
          <CalendarClock size={12} aria-hidden className="shrink-0" />
          <span aria-hidden className="ac-tabular hidden sm:inline">
            {chip.label}
          </span>
          <span aria-hidden className="ac-tabular sm:hidden">
            {tasks.length}
          </span>
          <span className="sr-only">{chip.title}</span>
        </span>
      }
    >
      <div className="flex flex-col gap-2 p-3">
        <div className="flex items-center gap-1.5 text-xs font-medium text-neutral-400">
          <CalendarClock size={12} aria-hidden />
          Scheduled tasks
        </div>
        <ul className="ac-scroll-thin flex max-h-80 flex-col gap-2 overflow-y-auto">
          {rows.map((task) => {
            const row = deriveScheduledTaskRow(task, now);
            const pending = busy.has(task.id);
            return (
              <li key={task.id} className="flex flex-col gap-1 rounded-md border border-neutral-800 p-2">
                <p className="line-clamp-3 select-text whitespace-pre-wrap break-words text-xs leading-4 text-neutral-200" title={row.prompt}>
                  {row.prompt}
                </p>
                <p className="text-[11px] leading-4 text-neutral-500">{row.schedule}</p>
                <p className={cn("text-[11px] leading-4", row.tone === "neutral" ? "text-neutral-400" : TONE[row.tone])}>{row.status}</p>
                <div className="mt-0.5 flex gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending || task.queuedAt !== null}
                    title={task.queuedAt !== null ? "A run already waits for this thread" : "Send the prompt now (after the running turn, if any)"}
                    onClick={() => {
                      setConfirming(null);
                      void runScheduledTaskNow(api, task);
                    }}
                  >
                    Run now
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    {...{ [DROPDOWN_DESTRUCTIVE_ATTRIBUTE]: "true" }}
                    onClick={() => {
                      if (confirming !== task.id) {
                        setConfirming(task.id);
                        return;
                      }
                      setConfirming(null);
                      void cancelScheduledTask(api, task);
                    }}
                  >
                    {confirming === task.id ? "Confirm cancel" : "Cancel"}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
        {notice !== null ? <p className="text-[11px] leading-4 text-warn-300">{notice}</p> : null}
      </div>
    </Dropdown>
  );
}
