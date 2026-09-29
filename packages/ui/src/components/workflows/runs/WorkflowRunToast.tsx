/**
 * The toast a finished workflow run raises in the open clients (spec §5.11):
 * "Workflow failed: <name>" (danger) — or, when the workflow asks for it,
 * "Workflow finished: <name>" — with **Open**, which opens the workflow's
 * editor tab on the run. The newest shows; older ones behind it are counted.
 *
 * Positioning belongs to `ToastStack` — this renders only its card.
 */

import React, { useSyncExternalStore } from "react";
import { CircleCheck, CircleX, X } from "lucide-react";

import { cn } from "../../../lib/cn";
import {
  dismissWorkflowToasts,
  workflowNotificationsStore,
  type WorkflowNotificationsState,
  type WorkflowRunNotice
} from "../../../lib/workflows/notifications";
import { ACTION_TOAST_AUTO_DISMISS_MS, useAutoDismiss } from "../../status/use-auto-dismiss";
import { openWorkflowRunInEditor } from "./open-run";

const toastsOf = (state: WorkflowNotificationsState): WorkflowNotificationsState["toasts"] => state.toasts;

interface WorkflowRunToastCardProps {
  notice: WorkflowRunNotice;
  /** Toasts behind this one. */
  more: number;
  onOpen: () => void;
  onDismiss: () => void;
}

/** The card as a picture of its props (the render checks draw it without a store). */
const WorkflowRunToastCard: React.FC<WorkflowRunToastCardProps> = ({ notice, more, onOpen, onDismiss }) => {
  const failed = notice.tone === "danger";
  const Icon = failed ? CircleX : CircleCheck;
  return (
    <div
      role={failed ? "alert" : "status"}
      className={cn(
        "pointer-events-auto flex w-full max-w-lg items-start gap-2.5 rounded-lg border bg-neutral-900/95 py-2 pl-3 pr-2 text-sm shadow-xl shadow-black/40 backdrop-blur",
        failed ? "border-danger-500/40" : "border-ok/30"
      )}
    >
      <Icon size={16} aria-hidden className={cn("mt-0.5 shrink-0", failed ? "text-danger" : "text-ok")} />
      <div className="min-w-0 flex-1 text-neutral-200">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{notice.title}</span>
          {more > 0 ? (
            <span className="shrink-0 rounded-full bg-neutral-800 px-1.5 text-[11px] text-neutral-400">+{more}</span>
          ) : null}
        </div>
        <div className="line-clamp-2 break-words text-[12px] text-neutral-400">{notice.message}</div>
        <button
          type="button"
          onClick={onOpen}
          className="mt-1.5 inline-flex min-h-8 items-center rounded border border-neutral-700 px-2.5 text-[12px] text-neutral-300 transition-colors hover:border-neutral-600 hover:bg-neutral-800 hover:text-neutral-100"
        >
          Open run
        </button>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
      >
        <X size={14} />
      </button>
    </div>
  );
};

export const WorkflowRunToast: React.FC = () => {
  const toasts = useSyncExternalStore(
    workflowNotificationsStore.subscribe,
    () => toastsOf(workflowNotificationsStore.getState()),
    () => toastsOf(workflowNotificationsStore.getState())
  );
  const newest = toasts[0] ?? null;
  useAutoDismiss(newest ? newest.runId : null, dismissWorkflowToasts, ACTION_TOAST_AUTO_DISMISS_MS);
  if (!newest) return null;
  return (
    <WorkflowRunToastCard
      notice={newest}
      more={toasts.length - 1}
      onDismiss={dismissWorkflowToasts}
      onOpen={() => {
        dismissWorkflowToasts();
        openWorkflowRunInEditor({
          runId: newest.runId,
          workflowId: newest.workflowId,
          workflowName: newest.workflowName,
          ...(newest.projectPath ? { projectPath: newest.projectPath } : {})
        });
      }}
    />
  );
};
