/**
 * Opening a session's tab from outside the app: a tap on one of its push
 * notifications (needs input, finished, plan ready, approval needed, an
 * agent's own `notify_user`; daemon `push.ts`, `tag: session-<id>`). The
 * service worker either messages an open window
 * (`{type: "orquester:open-session", sessionId}`) or opens `/?session=<id>`;
 * the web host hands either to `requestSessionDeepLink`, and the mounted
 * `SessionDeepLinkHost` opens the tab once the app is connected. The workflow
 * run link (`lib/workflows/deep-link.ts`) is the same shape.
 *
 * Everything off the wire (a URL, a message) is parsed here, strictly.
 */

import type { ApiClient } from "./api-client";
import { refreshProjectIndex } from "./project-index";
import type { ProjectSummary } from "../types";

export const SESSION_OPEN_MESSAGE = "orquester:open-session";

export interface SessionDeepLink {
  sessionId: string;
}

/** The same id grammar the service worker checks (`sw.js` `isLinkId`). */
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const idOf = (value: unknown): string | null => (typeof value === "string" && ID.test(value) ? value : null);

/** `?session=<id>`, or null (none, or a malformed id). */
export function parseSessionDeepLink(search: string): SessionDeepLink | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  } catch {
    return null;
  }
  const sessionId = idOf(params.get("session"));
  return sessionId ? { sessionId } : null;
}

/** The URL without the deep-link parameter (the address bar should not reopen it on reload). */
export function stripSessionDeepLink(href: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  url.searchParams.delete("session");
  const search = url.searchParams.toString();
  return `${url.pathname}${search ? `?${search}` : ""}${url.hash}`;
}

/** A service worker's message, or null when it is anything else. */
export function parseSessionOpenMessage(data: unknown): SessionDeepLink | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (record.type !== SESSION_OPEN_MESSAGE) return null;
  const sessionId = idOf(record.sessionId);
  return sessionId ? { sessionId } : null;
}

// ---------------------------------------------------------------------------
// The pending link (one at a time: the newest wins)
// ---------------------------------------------------------------------------

let pending: SessionDeepLink | null = null;
const listeners = new Set<() => void>();

/** Ask the app to open a session's tab as soon as it can. */
export function requestSessionDeepLink(link: SessionDeepLink): void {
  pending = { sessionId: link.sessionId };
  for (const listener of [...listeners]) listener();
}

export function pendingSessionDeepLink(): SessionDeepLink | null {
  return pending;
}

/** Take the pending link (it is opened once). */
export function takeSessionDeepLink(): SessionDeepLink | null {
  const link = pending;
  pending = null;
  if (link) for (const listener of [...listeners]) listener();
  return link;
}

export function subscribeSessionDeepLink(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// Where it leads
// ---------------------------------------------------------------------------

export type SessionLinkTarget =
  | { kind: "open"; sessionId: string; project: ProjectSummary }
  | { kind: "gone"; message: string };

/**
 * Where a session's link leads, asked of the daemon rather than the store (on
 * a cold start the store is still loading): the session's own project, when
 * the session still exists and its project is one this client may show — an
 * unarchived project of an unarchived workspace, the same curtain the
 * Attention Center and the command palette keep (`lib/project-index.ts`). A
 * failed request throws; every other outcome is an answer.
 */
export async function resolveSessionDeepLink(
  api: Pick<ApiClient, "listSessions" | "listWorkspaces" | "listProjects">,
  sessionId: string
): Promise<SessionLinkTarget> {
  const session = (await api.listSessions()).find((candidate) => candidate.id === sessionId);
  if (!session) return { kind: "gone", message: "That session no longer exists." };
  if (!session.projectPath) return { kind: "gone", message: "That session has no project to open it in." };
  const index = await refreshProjectIndex(api as ApiClient, await api.listWorkspaces());
  const project = index.visible.get(session.projectPath);
  if (project) return { kind: "open", sessionId, project };
  return {
    kind: "gone",
    message: index.incomplete
      ? "Couldn't open that session: its project could not be listed."
      : "That session's project is archived or no longer exists."
  };
}
