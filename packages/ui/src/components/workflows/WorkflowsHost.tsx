/**
 * Mounted once by the app shell. It
 *
 * - opens a workflow run asked for from anywhere (a chat tab's Workflow chip,
 *   through `lib/workflows/open-bridge.ts`) as the workflow's editor tab in
 *   Runs mode — in the open project, else the workflow's own;
 * - opens a push notification's run (`lib/workflows/deep-link.ts`: the
 *   service worker's message, or `/?workflow=…&run=…` on a cold start) once
 *   the app is connected and knows the workflow — in the workflow's own
 *   project, where the notification is about.
 */

import React, { useEffect, useSyncExternalStore } from "react";

import { useApi } from "../../context/orquester-context";
import { jumpToProject, resolveProjectRef } from "../../lib/session-nav";
import {
  decideDeepLink,
  pendingWorkflowDeepLink,
  subscribeWorkflowDeepLink,
  takeWorkflowDeepLink,
  type WorkflowDeepLink
} from "../../lib/workflows/deep-link";
import { markWorkflowRunViewed } from "../../lib/workflows/notifications";
import { showRunInWorkflowTabs, subscribeOpenWorkflowRun } from "../../lib/workflows/open-bridge";
import { loadWorkflows, workflowsStore } from "../../lib/workflows/store";
import { useAppStore } from "../../store/app";

/** Open the workflow's editor tab in `projectPath` (jumping there when it is not the open one), on `runId`. */
function openInProject(projectPath: string, link: WorkflowDeepLink, title: string | undefined): void {
  const app = useAppStore.getState();
  if (app.currentProject?.path !== projectPath) {
    jumpToProject({ project: resolveProjectRef(projectPath, app.workspaces, app.projects) });
  }
  useAppStore.getState().openWorkflowTab(projectPath, link.workflowId, {
    ...(link.runId ? { runId: link.runId } : {}),
    ...(title ? { title } : {})
  });
  if (link.runId) {
    showRunInWorkflowTabs({ workflowId: link.workflowId, runId: link.runId });
    markWorkflowRunViewed(link.runId);
  }
}

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
        showRunInWorkflowTabs({ workflowId: target.workflowId, runId: target.runId });
      }),
    []
  );

  // A notification's run: wait until it can be opened, then open it once.
  const pending = useSyncExternalStore(subscribeWorkflowDeepLink, pendingWorkflowDeepLink, () => null);
  const connected = useAppStore((state) => state.connectionStatus === "connected");
  const currentProjectPath = useAppStore((state) => state.currentProject?.path ?? null);
  const workflows = useSyncExternalStore(workflowsStore.subscribe, workflowsStore.getState, workflowsStore.getState);
  const api = useApi();
  useEffect(() => {
    // Nothing else may have asked for the list yet (the rail closed on a cold start).
    if (pending && connected && workflows.load.status === "idle") void loadWorkflows(api);
  }, [pending, connected, workflows.load.status, api]);
  useEffect(() => {
    if (!pending) return;
    const summary = workflows.summaries.get(pending.workflowId);
    const decision = decideDeepLink({
      connected,
      workflowsLoaded: workflows.load.status === "loaded",
      workflow: summary ? { projectPath: summary.project.kind === "existing" ? summary.project.projectPath : null } : null,
      currentProjectPath
    });
    if (decision.kind === "wait") return;
    const link = takeWorkflowDeepLink();
    if (!link) return;
    if (decision.kind === "gone") {
      useAppStore.getState().setNotice({ message: decision.message });
      return;
    }
    if (!decision.projectPath) {
      useAppStore.getState().setNotice({ message: "Open a project to see this workflow run." });
      return;
    }
    openInProject(decision.projectPath, link, summary?.name);
  }, [pending, connected, currentProjectPath, workflows]);

  return null;
};
