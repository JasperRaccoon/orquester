/**
 * Where a desktop notification's click goes (`desktop-host.ts`): the session's
 * tab or a workflow run, each through its deep link — the same paths a tapped
 * web push takes, so the session is checked against the daemon and opened once
 * the app is connected, even when the click relaunched the window.
 */

import { serverViewOpen, useAppStore } from "../store/app";
import type { DesktopNotificationTarget } from "./desktop-host";
import { requestSessionDeepLink } from "./session-deep-link";
import { requestWorkflowDeepLink } from "./workflows/deep-link";

/** The session tab on screen (the open project's, else the workspace's), or null — none while a server-level view covers it. */
export function viewingSessionId(): string | null {
  const state = useAppStore.getState();
  if (serverViewOpen(state)) return null;
  const key = state.currentProject?.path ?? state.currentWorkspace ?? null;
  return key === null ? null : (state.activeTabByProject[key] ?? null);
}

/** Open what a notification points at. */
export function openNotificationTarget(target: DesktopNotificationTarget): void {
  if (target.kind === "workflow") {
    requestWorkflowDeepLink({ workflowId: target.workflowId, runId: target.runId });
    return;
  }
  requestSessionDeepLink({ sessionId: target.sessionId });
}
