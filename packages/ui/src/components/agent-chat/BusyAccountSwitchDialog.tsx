/**
 * The warning before an account switch on a busy chat (spec 2026-11-14 §3–§4).
 *
 * Shown by the account chip's pick while the chat works (`chatAccountSwitchGate`
 * → `busy`), before anything is sent. It says what runs, that it will be
 * stopped and the agent restarted on the chosen account, and what happens
 * after; its confirm posts the account route with `whileBusy: true`. The
 * request stays open until the daemon has stopped, switched and continued, so
 * the dialog shows that progress, and a failure's reason, in place.
 */

import React from "react";
import { AlertTriangle, LoaderCircle } from "lucide-react";

import { Button, Modal } from "../ui";

export interface BusyAccountSwitchWork {
  turnActive: boolean;
  liveAgents: number;
  liveShells: number;
  pendingApprovals: number;
  pendingQuestions: number;
  queuedCount: number;
}

export interface BusyAccountSwitchDialogProps {
  open: boolean;
  /** The chosen account's label. */
  accountLabel: string;
  /** What runs now, live: the counts may move while the dialog is up. */
  work: BusyAccountSwitchWork;
  /** The goal the daemon will handle (`chatAccountSwitchGate`'s `busy.goal`). */
  goal: "continuing" | "held" | null;
  /** The confirmed request is open. */
  running: boolean;
  /** Why the last confirm failed, or null. */
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** "the current turn, 2 subagents and an open approval" — what a stop would end. */
function runningList(work: BusyAccountSwitchWork): string | null {
  const parts: string[] = [];
  if (work.turnActive) parts.push("the current turn");
  if (work.liveAgents > 0) parts.push(plural(work.liveAgents, "subagent", "subagents"));
  if (work.liveShells > 0) parts.push(plural(work.liveShells, "background shell", "background shells"));
  if (work.pendingApprovals > 0) {
    parts.push(work.pendingApprovals === 1 ? "an open approval" : `${work.pendingApprovals} open approvals`);
  }
  if (work.pendingQuestions > 0) {
    parts.push(work.pendingQuestions === 1 ? "an open question" : `${work.pendingQuestions} open questions`);
  }
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

export function BusyAccountSwitchDialog({
  open,
  accountLabel,
  work,
  goal,
  running,
  error,
  onConfirm,
  onClose
}: BusyAccountSwitchDialogProps): React.ReactElement {
  const list = runningList(work);
  return (
    <Modal open={open} onClose={onClose} className="max-w-md" ariaLabel={`Switch to ${accountLabel}`}>
      <div className="w-full overflow-y-auto p-5">
        <div className="mb-3 flex items-center gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-warning-500/10 text-warning">
            <AlertTriangle size={16} aria-hidden />
          </span>
          <p className="min-w-0 text-sm font-medium text-neutral-100">
            Switch to {accountLabel} now?
          </p>
        </div>

        <div className="space-y-2 text-sm text-neutral-400">
          {list !== null ? (
            <p>
              Running now: {list}. All of it will be stopped and the agent restarted on {accountLabel}.
            </p>
          ) : goal === null ? (
            <p>The agent will be restarted on {accountLabel}.</p>
          ) : null}
          {goal === "continuing" ? (
            <p>The goal will be paused, the chat moved to {accountLabel}, and the goal resumed there.</p>
          ) : goal === "held" ? (
            <p>
              The goal is paused for an Orquester update. It will move to {accountLabel} and resume there by
              itself after the update.
            </p>
          ) : list !== null ? (
            <p>Orquester will then ask the agent to resume its subagents and rerun what it still needs.</p>
          ) : null}
          {work.queuedCount > 0 ? (
            <p>
              {work.queuedCount === 1 ? "Your queued message stays" : "Your queued messages stay"} queued and
              {work.queuedCount === 1 ? " goes" : " go"} out after the switch.
            </p>
          ) : null}
        </div>

        {error !== null ? (
          <p role="alert" className="mt-3 text-xs text-danger">
            {error}
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} autoFocus>
            {running ? "Close" : "Cancel"}
          </Button>
          <Button size="sm" disabled={running} onClick={onConfirm} aria-busy={running}>
            {running ? (
              <>
                <LoaderCircle size={12} className="animate-spin" aria-hidden />
                Switching…
              </>
            ) : list !== null ? (
              "Stop and switch"
            ) : (
              "Switch"
            )}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
