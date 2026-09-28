/**
 * The Attention Center's "Workflow failed" source (spec §5.11): a failed run
 * of any workflow, one row each, newest first — opening it goes to the run
 * (and clears the row), × dismisses it, and viewing the run anywhere clears
 * it too. Rendered at the top of the sidebar's Opened Agents section, whose
 * header also counts it.
 *
 * Its own list, not an `AgentSessionEntry`: those are sessions (a status dot,
 * the repo grouping, the Ctrl+Shift+A cycle focuses a tab), and a run is none
 * of that.
 */

import React, { useSyncExternalStore } from "react";
import { CircleX, Workflow as WorkflowIcon, X } from "lucide-react";

import { cn } from "../../../lib/cn";
import { formatAgo } from "../../../lib/workflows/format";
import {
  dismissWorkflowAttention,
  workflowNotificationsStore,
  type WorkflowAttentionEntry,
  type WorkflowNotificationsState
} from "../../../lib/workflows/notifications";
import { openWorkflowRunInEditor } from "./open-run";
import { useNow } from "./shared";

const attentionOf = (state: WorkflowNotificationsState): WorkflowNotificationsState["attention"] => state.attention;

/** The failed runs waiting in the Attention Center. */
export function useWorkflowAttention(): readonly WorkflowAttentionEntry[] {
  return useSyncExternalStore(
    workflowNotificationsStore.subscribe,
    () => attentionOf(workflowNotificationsStore.getState()),
    () => attentionOf(workflowNotificationsStore.getState())
  );
}

interface WorkflowAttentionRowsProps {
  entries: readonly WorkflowAttentionEntry[];
  now: number;
  onOpen: (entry: WorkflowAttentionEntry) => void;
  onDismiss: (runId: string) => void;
  /** Bigger targets (the mobile drawer). */
  touch?: boolean;
}

/** The group as a picture of its props. */
const WorkflowAttentionRows: React.FC<WorkflowAttentionRowsProps> = ({
  entries,
  now,
  onOpen,
  onDismiss,
  touch
}) => {
  if (entries.length === 0) return null;
  return (
    <div className="pb-1">
      <div className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-neutral-600">
        Workflow failed
      </div>
      <ul>
        {entries.map((entry) => (
          <li key={entry.runId} className="group flex items-center gap-0.5 rounded hover:bg-neutral-800">
            <button
              type="button"
              onClick={() => onOpen(entry)}
              title={`${entry.workflowName} — ${entry.detail}`}
              className={cn(
                "flex min-w-0 flex-1 items-center gap-2 rounded px-2 text-left text-sm text-neutral-300 hover:text-neutral-100",
                touch ? "min-h-10" : "py-1.5"
              )}
            >
              <span className="relative flex h-4 w-4 shrink-0 items-center justify-center text-neutral-500">
                <WorkflowIcon size={14} aria-hidden />
                <CircleX
                  size={9}
                  aria-hidden
                  className="absolute -bottom-0.5 -right-1 rounded-full bg-neutral-900 text-danger"
                />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{entry.workflowName}</span>
                <span className="block truncate text-[11px] leading-4 text-danger/90">{entry.detail}</span>
              </span>
              <span className="shrink-0 text-[10px] text-neutral-500">{formatAgo(entry.at, now)}</span>
            </button>
            <button
              type="button"
              aria-label={`Dismiss ${entry.workflowName}`}
              onClick={() => onDismiss(entry.runId)}
              className={cn(
                "inline-flex shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-700 hover:text-neutral-200",
                touch ? "h-10 w-10" : "h-6 w-6"
              )}
            >
              <X size={13} aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
};

/** The live group, as the sidebar mounts it. */
export const WorkflowAttention: React.FC<{ touch?: boolean }> = ({ touch }) => {
  const entries = useWorkflowAttention();
  const now = useNow(false);
  return (
    <WorkflowAttentionRows
      entries={entries}
      now={now}
      touch={touch}
      onDismiss={dismissWorkflowAttention}
      onOpen={(entry) =>
        openWorkflowRunInEditor({
          runId: entry.runId,
          workflowId: entry.workflowId,
          workflowName: entry.workflowName,
          ...(entry.projectPath ? { projectPath: entry.projectPath } : {})
        })
      }
    />
  );
};
