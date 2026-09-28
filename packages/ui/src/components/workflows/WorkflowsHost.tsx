/**
 * Mounted once by the app shell: opens a workflow run asked for from anywhere
 * (a chat tab's Workflow chip, through `lib/workflows/open-bridge.ts`) as the
 * workflow's editor tab in Runs mode — in the open project, else the
 * workflow's own.
 */

import React, { useEffect } from "react";

import { subscribeOpenWorkflowRun } from "../../lib/workflows/open-bridge";
import { workflowsStore } from "../../lib/workflows/store";
import { useAppStore } from "../../store/app";

export const WorkflowsHost: React.FC = () => {
  useEffect(
    () =>
      subscribeOpenWorkflowRun((target) => {
        const app = useAppStore.getState();
        const summary = workflowsStore.getState().summaries.get(target.workflowId);
        const own = summary?.project.kind === "existing" ? summary.project.projectPath : null;
        const projectPath = app.currentProject?.path ?? own;
        if (!projectPath) return;
        app.openWorkflowTab(projectPath, target.workflowId, {
          runId: target.runId,
          ...(summary ? { title: summary.name } : {})
        });
      }),
    []
  );
  return null;
};
