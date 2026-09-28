/**
 * Which connections the canvas accepts (workflows spec §3.4): an existing
 * output handle of the source, a target that takes input, no self-loop, no
 * duplicate, and never a cycle. Pure — `isValidConnection` asks it while the
 * user drags, `connectBlocks` asks it again before an edge is added.
 */

import { acceptsInput, downstreamOf, outputHandles, type Workflow, type WorkflowEdge } from "@orquester/api";

export interface ConnectionRequest {
  source: string;
  sourceHandle: string | null | undefined;
  target: string;
}

/** Why `request` cannot be an edge of `workflow`, or null when it can. */
export function connectionRefusal(workflow: Pick<Workflow, "nodes" | "edges">, request: ConnectionRequest): string | null {
  const source = workflow.nodes.find((node) => node.id === request.source);
  const target = workflow.nodes.find((node) => node.id === request.target);
  if (!source || !target) return "That block no longer exists.";
  if (source.id === target.id) return "A block cannot feed itself.";
  const handle = request.sourceHandle ?? "success";
  if (!outputHandles(source).includes(handle)) return `${source.name} has no “${handle}” output.`;
  if (!acceptsInput(target)) return target.type === "note" ? "Notes never connect." : "A trigger has no input.";
  if (
    workflow.edges.some((edge) => edge.source === source.id && edge.sourceHandle === handle && edge.target === target.id)
  ) {
    return "Those blocks are already connected that way.";
  }
  if (downstreamOf(workflow, target.id).has(source.id)) return "That would make a loop — workflows run in one direction.";
  return null;
}

export function isValidWorkflowConnection(workflow: Pick<Workflow, "nodes" | "edges">, request: ConnectionRequest): boolean {
  return connectionRefusal(workflow, request) === null;
}

/** `workflow` with the edge added, or the same object when it is refused. */
export function connectBlocks<W extends Pick<Workflow, "nodes" | "edges">>(
  workflow: W,
  request: ConnectionRequest,
  mintId: () => string
): W {
  if (connectionRefusal(workflow, request) !== null) return workflow;
  const edge: WorkflowEdge = {
    id: mintId(),
    source: request.source,
    sourceHandle: request.sourceHandle ?? "success",
    target: request.target
  };
  return { ...workflow, edges: [...workflow.edges, edge] };
}
