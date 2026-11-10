/**
 * Which connections the canvas accepts (workflows spec §3.4; loops: spec
 * 2026-11-10 §7.1): an existing output handle of the source, a target that
 * takes input, no self-loop and no duplicate. A connection onto a block that
 * already runs before the source (an ancestor through ordinary edges) is a
 * **loop edge** — made with the default limit — unless it leaves a failure
 * output, its output already leads elsewhere, or it points at a trigger. An
 * output with a loop edge carries nothing else.
 *
 * Pure — `isValidConnection` asks it while the user drags, `connectBlocks`
 * asks it again before an edge is added.
 */

import {
  acceptsInput,
  isLoopEdge,
  outputHandles,
  workflowHandleLabel,
  type Workflow,
  type WorkflowEdge,
  type WorkflowEdgeLoop
} from "@orquester/api";

import { defaultLoopSettings, isAncestor } from "../../../lib/workflows/loops";

export interface ConnectionRequest {
  source: string;
  sourceHandle: string | null | undefined;
  target: string;
}

export type ConnectionClass =
  | { kind: "edge" }
  /** A loop edge back to `targetName`. */
  | { kind: "loop"; targetName: string }
  | { kind: "refused"; reason: string };

export interface ConnectionOptions {
  /** Loops are refused ("Move to another output" never makes one). Default: allowed. */
  loops?: boolean;
}

const ONE_WAY = "That would make a loop — workflows run in one direction.";

/** What connecting `request` would make in `workflow`: an edge, a loop edge, or a refusal with its reason. */
export function classifyConnection(
  workflow: Pick<Workflow, "nodes" | "edges">,
  request: ConnectionRequest,
  options: ConnectionOptions = {}
): ConnectionClass {
  const refuse = (reason: string): ConnectionClass => ({ kind: "refused", reason });
  const source = workflow.nodes.find((node) => node.id === request.source);
  const target = workflow.nodes.find((node) => node.id === request.target);
  if (!source || !target) return refuse("That block no longer exists.");
  if (source.id === target.id) return refuse("A block cannot feed itself.");
  const handle = request.sourceHandle ?? "success";
  if (!outputHandles(source).includes(handle)) return refuse(`${source.name} has no “${handle}” output.`);
  const back = isAncestor(workflow, target.id, source.id);
  if (!acceptsInput(target)) {
    if (target.type === "note") return refuse("Notes never connect.");
    return refuse(
      back && options.loops !== false
        ? "A loop cannot go back to a trigger — loop back to the first step after it."
        : "A trigger has no input."
    );
  }
  const leaving = workflow.edges.filter((edge) => edge.source === source.id && edge.sourceHandle === handle);
  if (leaving.some((edge) => edge.target === target.id)) return refuse("Those blocks are already connected that way.");
  const label = workflowHandleLabel(source, handle);
  const output = label === "success" ? source.name : `${source.name} · ${label}`;
  const looping = leaving.find(isLoopEdge);
  if (looping) {
    const to = workflow.nodes.find((node) => node.id === looping.target)?.name ?? looping.target;
    return refuse(`${output} loops back to ${to} — an output with a loop leads nowhere else.`);
  }
  if (!back) return { kind: "edge" };
  if (options.loops === false) return refuse(ONE_WAY);
  if (handle === "error") return refuse("A failure output cannot loop back — loop from another output.");
  if (leaving.length > 0) {
    const to = workflow.nodes.find((node) => node.id === leaving[0]!.target)?.name ?? leaving[0]!.target;
    return refuse(`${output} already leads to ${to} — a loop needs an output of its own.`);
  }
  return { kind: "loop", targetName: target.name };
}

/** Why `request` cannot be an edge of `workflow`, or null when it can (a loop edge counts as can). */
export function connectionRefusal(
  workflow: Pick<Workflow, "nodes" | "edges">,
  request: ConnectionRequest,
  options: ConnectionOptions = {}
): string | null {
  const verdict = classifyConnection(workflow, request, options);
  return verdict.kind === "refused" ? verdict.reason : null;
}

/**
 * `workflow` with the edge added — a loop edge (with `loop`, else the default
 * limit) when it points back to an ancestor — or the same object when it is
 * refused.
 */
export function connectBlocks<W extends Pick<Workflow, "nodes" | "edges">>(
  workflow: W,
  request: ConnectionRequest,
  mintId: () => string,
  options: ConnectionOptions & { loop?: WorkflowEdgeLoop } = {}
): W {
  const verdict = classifyConnection(workflow, request, options);
  if (verdict.kind === "refused") return workflow;
  const edge: WorkflowEdge = {
    id: mintId(),
    source: request.source,
    sourceHandle: request.sourceHandle ?? "success",
    target: request.target
  };
  if (verdict.kind === "loop") edge.loop = options.loop ? { ...options.loop } : defaultLoopSettings();
  return { ...workflow, edges: [...workflow.edges, edge] };
}
