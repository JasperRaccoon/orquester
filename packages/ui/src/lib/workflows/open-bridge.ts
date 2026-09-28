/**
 * Open a workflow run from anywhere — a chat tab's Workflow chip (workflows spec §5.10) — without
 * holding a ref to the workflows UI. Whatever shows runs (the rail's Workflows panel / the run view)
 * subscribes once; with no listener, opening does nothing and reports `false`.
 *
 * The same listener-set pattern as `components/right-rail/saved-prompts/editor-bridge.ts`.
 */

import type { SessionSummary, WorkflowSessionOwner } from "@orquester/api";

/** Which run to show, and the block in it that started the session. */
export type WorkflowRunTarget = Omit<WorkflowSessionOwner, "kind">;

type Listener = (target: WorkflowRunTarget) => void;

const listeners = new Set<Listener>();

/** Ask the mounted workflows UI to open a run. `false` when nothing is listening (a no-op). */
export function openWorkflowRun(target: WorkflowRunTarget): boolean {
  if (listeners.size === 0) return false;
  const copy = { workflowId: target.workflowId, runId: target.runId, nodeId: target.nodeId };
  for (const listener of [...listeners]) listener(copy);
  return true;
}

/** The workflows UI subscribes; returns the unsubscribe function. */
export function subscribeOpenWorkflowRun(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The run a tab links to: only a chat tab a workflow started, with an owner a client can use.
 * The summary comes off the wire, so a malformed owner (a newer daemon's shape) links nowhere.
 */
export function workflowRunTargetOf(
  session: Pick<SessionSummary, "kind" | "owner"> | null | undefined
): WorkflowRunTarget | null {
  if (!session || session.kind !== "agent-chat") return null;
  const owner = session.owner as Partial<WorkflowSessionOwner> | null | undefined;
  if (!owner || typeof owner !== "object" || owner.kind !== "workflow") return null;
  const { workflowId, runId, nodeId } = owner;
  if (!isId(workflowId) || !isId(runId) || !isId(nodeId)) return null;
  return { workflowId, runId, nodeId };
}

const isId = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
