/**
 * The canvas's edits as pure functions over a definition: add a block (and
 * wire it from an output, or into an edge), remove blocks and edges, move and
 * nudge. The editor store turns each into one undo step.
 */

import {
  acceptsInput,
  defaultNodeName,
  outputHandles,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeType
} from "@orquester/api";

import { liveDefaultNodeConfig } from "../../../lib/workflows/chain-models";

import { connectBlocks } from "./connection";

export const GRID = 16;
export const snapToGrid = (value: number): number => Math.round(value / GRID) * GRID;

type Graph = Pick<Workflow, "nodes" | "edges"> & { pinned?: Workflow["pinned"] };

export interface AddBlockOptions {
  /** Wire the new block from this output. */
  from?: { nodeId: string; handle: string } | null;
  /** Split this edge: its source feeds the new block, the new block feeds its target. */
  intoEdgeId?: string | null;
}

/** A fresh block of `type` at `position` (snapped), with its default config and a free name. */
export function newBlock(
  type: WorkflowNodeType,
  position: { x: number; y: number },
  existing: readonly Pick<WorkflowNode, "name">[],
  mintId: () => string
): WorkflowNode {
  return {
    id: mintId(),
    type,
    name: defaultNodeName(type, existing.map((node) => node.name)),
    position: { x: snapToGrid(position.x), y: snapToGrid(position.y) },
    config: liveDefaultNodeConfig(type)
  } as WorkflowNode;
}

export function addBlock<W extends Graph>(
  workflow: W,
  type: WorkflowNodeType,
  position: { x: number; y: number },
  mintId: () => string,
  options: AddBlockOptions = {}
): { workflow: W; nodeId: string } {
  const node = newBlock(type, position, workflow.nodes, mintId);
  let next: W = { ...workflow, nodes: [...workflow.nodes, node] };
  if (options.intoEdgeId) {
    const edge = workflow.edges.find((candidate) => candidate.id === options.intoEdgeId);
    if (edge && acceptsInput(node)) {
      next = { ...next, edges: next.edges.filter((candidate) => candidate.id !== edge.id) };
      next = connectBlocks(next, { source: edge.source, sourceHandle: edge.sourceHandle, target: node.id }, mintId);
      const out = outputHandles(node)[0];
      if (out) next = connectBlocks(next, { source: node.id, sourceHandle: out, target: edge.target }, mintId);
    }
  } else if (options.from) {
    next = connectBlocks(next, { source: options.from.nodeId, sourceHandle: options.from.handle, target: node.id }, mintId);
  }
  return { workflow: next, nodeId: node.id };
}

/** Without these blocks (their edges and pinned data go too) and these edges. */
export function removeElements<W extends Graph>(workflow: W, nodeIds: Iterable<string>, edgeIds: Iterable<string>): W {
  const nodes = new Set(nodeIds);
  const edges = new Set(edgeIds);
  if (nodes.size === 0 && edges.size === 0) return workflow;
  const keptNodes = workflow.nodes.filter((node) => !nodes.has(node.id));
  const keptEdges = workflow.edges.filter(
    (edge) => !edges.has(edge.id) && !nodes.has(edge.source) && !nodes.has(edge.target)
  );
  if (keptNodes.length === workflow.nodes.length && keptEdges.length === workflow.edges.length) return workflow;
  const next: W = { ...workflow, nodes: keptNodes, edges: keptEdges };
  if (workflow.pinned && [...nodes].some((id) => id in workflow.pinned!)) {
    const pinned = { ...workflow.pinned };
    for (const id of nodes) delete pinned[id];
    next.pinned = pinned;
  }
  return next;
}

/** Blocks moved to `positions` (snapped); the same object when nothing moved. */
export function moveNodes<W extends Graph>(workflow: W, positions: Readonly<Record<string, { x: number; y: number }>>): W {
  let changed = false;
  const nodes = workflow.nodes.map((node) => {
    const target = positions[node.id];
    if (!target) return node;
    const position = { x: snapToGrid(target.x), y: snapToGrid(target.y) };
    if (position.x === node.position.x && position.y === node.position.y) return node;
    changed = true;
    return { ...node, position };
  });
  return changed ? { ...workflow, nodes } : workflow;
}

/** Arrow-key nudge: the selection moved by (dx, dy) grid steps. */
export function nudgeNodes<W extends Graph>(workflow: W, nodeIds: readonly string[], dx: number, dy: number): W {
  const ids = new Set(nodeIds);
  const positions: Record<string, { x: number; y: number }> = {};
  for (const node of workflow.nodes) {
    if (ids.has(node.id)) positions[node.id] = { x: node.position.x + dx * GRID, y: node.position.y + dy * GRID };
  }
  return moveNodes(workflow, positions);
}

/** Replace one block (by id) with `update(node)`. */
export function updateNode<W extends Graph>(workflow: W, nodeId: string, update: (node: WorkflowNode) => WorkflowNode): W {
  let changed = false;
  const nodes = workflow.nodes.map((node) => {
    if (node.id !== nodeId) return node;
    const next = update(node);
    if (next !== node) changed = true;
    return next;
  });
  return changed ? { ...workflow, nodes } : workflow;
}

/** Edges whose source handle no longer exists (a switch case removed) go with it. */
export function pruneDanglingEdges<W extends Graph>(workflow: W): W {
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
  const edges = workflow.edges.filter((edge: WorkflowEdge) => {
    const source = byId.get(edge.source);
    return source !== undefined && byId.has(edge.target) && outputHandles(source).includes(edge.sourceHandle);
  });
  return edges.length === workflow.edges.length ? workflow : { ...workflow, edges };
}
