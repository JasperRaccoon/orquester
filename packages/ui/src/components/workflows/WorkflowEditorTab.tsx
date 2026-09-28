/**
 * The automated-workflow editor tab (workflows spec §7.2) — a PLACEHOLDER: a
 * centered empty state naming the workflow, until the editor (canvas, steps,
 * inspector, run view) replaces it. The props are the editor's contract with
 * `MainView`, modelled on `GitView`: `show` while the tab is visible (every
 * visible grid cell), `active` while it is the focused tab.
 */

import React from "react";
import { Workflow } from "lucide-react";

import { useWorkflowsState } from "../../lib/workflows/hooks";

export interface WorkflowEditorTabProps {
  workflowId: string;
  /** The tab's own title — the workflow's name as last known. */
  title: string;
  /** The run the run view shows, when one was asked for. */
  runId?: string | null;
  /** The project the tab is open in (the rail's), not necessarily the workflow's own. */
  projectPath: string;
  /** The focused tab. */
  active: boolean;
  /** Visible (the active tab, or any grid cell). */
  show: boolean;
}

export const WorkflowEditorTab: React.FC<WorkflowEditorTabProps> = ({ workflowId, title, runId }) => {
  const summary = useWorkflowsState().summaries.get(workflowId);
  const name = summary?.name ?? title;
  return (
    <div
      data-keyboard-surface=""
      className="flex h-full w-full flex-col items-center justify-center gap-3 bg-neutral-950 px-6 text-center"
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-neutral-800 bg-neutral-900 text-neutral-400">
        <Workflow size={22} aria-hidden />
      </span>
      <div className="space-y-1">
        <div className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">Workflow editor</div>
        <h2 className="text-base font-medium text-neutral-100">{name}</h2>
        {runId ? <p className="text-xs text-neutral-500">Run {runId.slice(0, 8)}</p> : null}
      </div>
    </div>
  );
};
