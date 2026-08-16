import { isProjectRefVisible, resolveProjectRef } from "../../lib/session-nav";
import type { ProjectSummary, SessionSummary, WorkspaceSummary } from "../../types";

export interface SessionOwner {
  title: string;
  project: ProjectSummary;
}

/**
 * The session a reported pid/port belongs to, or null when this client must not
 * name it: an unknown id (another client's session, or one that just exited), a
 * session with no project, or one behind the archived-data curtain. Kept pure
 * and separate from {@link SessionChip} so the curtain rule is directly testable
 * — a leak here would turn the System panel into a hole in it.
 */
export function resolveSessionOwner(
  sessionId: string,
  sessions: readonly SessionSummary[],
  workspaces: readonly WorkspaceSummary[],
  projects: readonly ProjectSummary[]
): SessionOwner | null {
  const session = sessions.find((item) => item.id === sessionId);
  if (!session || session.projectPath === "") {
    return null;
  }
  const project = resolveProjectRef(session.projectPath, workspaces, projects);
  return isProjectRefVisible(project, workspaces) ? { title: session.title, project } : null;
}
