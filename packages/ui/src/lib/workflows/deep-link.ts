/**
 * Opening a workflow run from outside the app (workflows spec §5.11): a push
 * notification's click. The service worker either messages an open window
 * (`{type: "orquester:open-workflow-run", workflowId, runId}`) or opens
 * `/?workflow=<id>&run=<runId>`; the web host hands either to
 * `requestWorkflowDeepLink`, and the mounted `WorkflowsHost` opens the tab once
 * it can — connected, and the workflow known.
 *
 * Everything off the wire (a URL, a message) is parsed here, strictly.
 */

export const WORKFLOW_RUN_MESSAGE = "orquester:open-workflow-run";

export interface WorkflowDeepLink {
  workflowId: string;
  runId: string | null;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const idOf = (value: unknown): string | null => (typeof value === "string" && ID.test(value) ? value : null);

/** `?workflow=<id>[&run=<id>]`, or null. A malformed run id is dropped, a malformed workflow id drops the link. */
export function parseWorkflowDeepLink(search: string): WorkflowDeepLink | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  } catch {
    return null;
  }
  const workflowId = idOf(params.get("workflow"));
  if (!workflowId) return null;
  return { workflowId, runId: idOf(params.get("run")) };
}

/** The URL without the deep-link parameters (the address bar should not reopen it on reload). */
export function stripWorkflowDeepLink(href: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  url.searchParams.delete("workflow");
  url.searchParams.delete("run");
  const search = url.searchParams.toString();
  return `${url.pathname}${search ? `?${search}` : ""}${url.hash}`;
}

/** A service worker's message, or null when it is anything else. */
export function parseWorkflowRunMessage(data: unknown): WorkflowDeepLink | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (record.type !== WORKFLOW_RUN_MESSAGE) return null;
  const workflowId = idOf(record.workflowId);
  if (!workflowId) return null;
  return { workflowId, runId: idOf(record.runId) };
}

// ---------------------------------------------------------------------------
// The pending link (one at a time: the newest wins)
// ---------------------------------------------------------------------------

let pending: WorkflowDeepLink | null = null;
const listeners = new Set<() => void>();

/** Ask the app to open a workflow (a run of it) as soon as it can. */
export function requestWorkflowDeepLink(link: WorkflowDeepLink): void {
  pending = { workflowId: link.workflowId, runId: link.runId };
  for (const listener of [...listeners]) listener();
}

export function pendingWorkflowDeepLink(): WorkflowDeepLink | null {
  return pending;
}

/** Take the pending link (it is opened once). */
export function takeWorkflowDeepLink(): WorkflowDeepLink | null {
  const link = pending;
  pending = null;
  if (link) for (const listener of [...listeners]) listener();
  return link;
}

export function subscribeWorkflowDeepLink(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export type DeepLinkDecision =
  | { kind: "wait" }
  | { kind: "open"; projectPath: string | null }
  | { kind: "gone"; message: string };

/**
 * What to do with a pending link now: wait while the app is not connected or
 * the workflows are not loaded yet; open it once the workflow is known — in
 * its own project when it has one (a notification is about that workflow),
 * else wherever the user is; say so when the workflow no longer exists.
 */
export function decideDeepLink(input: {
  connected: boolean;
  workflowsLoaded: boolean;
  /** The workflow's summary, when known. */
  workflow: { projectPath: string | null } | null;
  currentProjectPath: string | null;
}): DeepLinkDecision {
  if (!input.connected) return { kind: "wait" };
  if (input.workflow) return { kind: "open", projectPath: input.workflow.projectPath ?? input.currentProjectPath };
  if (!input.workflowsLoaded) return { kind: "wait" };
  return { kind: "gone", message: "That workflow no longer exists." };
}
