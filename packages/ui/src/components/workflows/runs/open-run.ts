/**
 * Going somewhere from a run: its editor tab on the run (a toast's or an
 * Attention entry's "Open"), and an agent block's chat tab ("Open session").
 * The app store's own navigation — `openWorkflowTab`, `jumpToProject` — so
 * the rail, the palette and these agree on what "go there" means.
 */

import { isAgentLikeSession } from "../../../lib/session-kind";
import { jumpToProject, resolveProjectRef } from "../../../lib/session-nav";
import { markWorkflowRunViewed } from "../../../lib/workflows/notifications";
import { useAppStore } from "../../../store/app";

export interface RunTarget {
  runId: string;
  workflowId: string;
  workflowName?: string;
  /** The run's own project, used only when no project is open. */
  projectPath?: string;
}

/**
 * Open the workflow's editor tab on the run: in the project that is open (the
 * tab is a view, not a binding — spec §7.2), else in the run's own project.
 * `false` when there is nowhere to open it (no project open, none known).
 */
export function openWorkflowRunInEditor(target: RunTarget): boolean {
  const state = useAppStore.getState();
  let projectPath = state.currentProject?.path ?? null;
  if (!projectPath && target.projectPath) {
    const project = resolveProjectRef(target.projectPath, state.workspaces, state.projects);
    jumpToProject({ project });
    projectPath = project.path;
  }
  if (!projectPath) {
    state.setNotice({ message: "Open a project to see this workflow run." });
    return false;
  }
  const title = target.workflowName?.trim();
  useAppStore.getState().openWorkflowTab(projectPath, target.workflowId, {
    runId: target.runId,
    ...(title ? { title } : {})
  });
  markWorkflowRunViewed(target.runId);
  return true;
}

export type OpenSessionResult = "opened" | "closed";

/**
 * Focus the chat tab of an agent block's session. `"closed"` when this client
 * has no such tab any more (closed, or swept after its run) — say so rather
 * than open nothing.
 */
export function focusWorkflowSession(sessionId: string): OpenSessionResult {
  const state = useAppStore.getState();
  const session = state.sessions.find((candidate) => candidate.id === sessionId);
  if (!session || !isAgentLikeSession(session) || !session.projectPath) return "closed";
  const project = resolveProjectRef(session.projectPath, state.workspaces, state.projects);
  jumpToProject({ project, sessionId });
  return "opened";
}

/** Whether the chat tab of `sessionId` is still open in this client. */
export function isWorkflowSessionOpen(sessionId: string): boolean {
  return useAppStore.getState().sessions.some((candidate) => candidate.id === sessionId);
}
