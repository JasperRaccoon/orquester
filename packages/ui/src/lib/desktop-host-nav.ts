/**
 * Where a desktop notification's click goes (`desktop-host.ts`): the session's
 * project and tab, or a workflow run through its deep link.
 */

import { useAppStore } from "../store/app";
import type { DesktopNotificationTarget } from "./desktop-host";
import { jumpToProject, resolveProjectRef } from "./session-nav";
import { requestWorkflowDeepLink } from "./workflows/deep-link";

/** The session tab on screen (the open project's, else the workspace's), or null. */
export function viewingSessionId(): string | null {
  const state = useAppStore.getState();
  const key = state.currentProject?.path ?? state.currentWorkspace ?? null;
  return key === null ? null : (state.activeTabByProject[key] ?? null);
}

/** Open a session's project and tab. False when the store does not know the session (yet). */
export function openSessionById(sessionId: string): boolean {
  const state = useAppStore.getState();
  const session = state.sessions.find((candidate) => candidate.id === sessionId);
  if (!session || session.projectPath === "") return false;
  jumpToProject({
    project: resolveProjectRef(session.projectPath, state.workspaces, state.projects),
    sessionId
  });
  return true;
}

/**
 * Open what a notification points at. A workflow run goes through the deep
 * link (opened once the workflow is known); a session the store has not
 * loaded yet — the click relaunched the window — is returned for the caller
 * to retry when the session list changes.
 */
export function openNotificationTarget(target: DesktopNotificationTarget): string | null {
  if (target.kind === "workflow") {
    requestWorkflowDeepLink({ workflowId: target.workflowId, runId: target.runId });
    return null;
  }
  return openSessionById(target.sessionId) ? null : target.sessionId;
}
