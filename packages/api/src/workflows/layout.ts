// Automated workflows — automatic layout (the editor's "Tidy up", nodes an agent adds through the
// MCP without a position). dagre, left to right. Positions are React Flow's: a node's TOP-LEFT
// corner, snapped to the editor's 16 px grid.

import dagre from "@dagrejs/dagre";

import { outputHandles } from "./graph.ts";
import type { WorkflowEdge, WorkflowNode } from "./types.ts";

export const LAYOUT_NODE_WIDTH = 240;
export const LAYOUT_NODE_HEIGHT = 96;
export const LAYOUT_RANK_SEP = 80;
export const LAYOUT_NODE_SEP = 40;
export const LAYOUT_GRID = 16;

export interface LayoutPoint {
  x: number;
  y: number;
}

type LayoutNode = Pick<WorkflowNode, "id" | "type" | "position"> & { config?: unknown };
type LayoutGraph = { nodes: readonly LayoutNode[]; edges: readonly Pick<WorkflowEdge, "source" | "sourceHandle" | "target">[] };

const snap = (value: number): number => Math.round(value / LAYOUT_GRID) * LAYOUT_GRID;

/**
 * dagre positions for the workflow's nodes (notes are never moved). With `onlyNodeIds`, only that
 * subgraph is laid out and it keeps its top-left corner where it was — "Tidy up" on a selection.
 */
export function autoLayout(workflow: LayoutGraph, opts: { onlyNodeIds?: Iterable<string> } = {}): Record<string, LayoutPoint> {
  const only = opts.onlyNodeIds === undefined ? null : new Set(opts.onlyNodeIds);
  const nodes = workflow.nodes.filter((node) => node.type !== "note" && (only === null || only.has(node.id)));
  if (nodes.length === 0) return {};
  const ids = new Set(nodes.map((node) => node.id));
  const byId = new Map(nodes.map((node) => [node.id, node]));

  const graph = new dagre.graphlib.Graph({ multigraph: false });
  graph.setGraph({ rankdir: "LR", ranksep: LAYOUT_RANK_SEP, nodesep: LAYOUT_NODE_SEP, marginx: 0, marginy: 0 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) graph.setNode(node.id, { width: LAYOUT_NODE_WIDTH, height: LAYOUT_NODE_HEIGHT });
  // Edges in handle order, so a block's first output (success, true, case:0) tends to sit on top.
  const edges = workflow.edges
    .filter((edge) => ids.has(edge.source) && ids.has(edge.target) && edge.source !== edge.target)
    .map((edge, index) => {
      const source = byId.get(edge.source)!;
      const rank = outputHandles(source).indexOf(edge.sourceHandle);
      return { edge, index, rank: rank < 0 ? Number.MAX_SAFE_INTEGER : rank };
    })
    .sort((a, b) => a.rank - b.rank || a.index - b.index);
  for (const { edge } of edges) graph.setEdge(edge.source, edge.target);
  dagre.layout(graph);

  const raw: Record<string, LayoutPoint> = {};
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (const node of nodes) {
    const laid = graph.node(node.id) as { x: number; y: number } | undefined;
    const x = (laid?.x ?? 0) - LAYOUT_NODE_WIDTH / 2;
    const y = (laid?.y ?? 0) - LAYOUT_NODE_HEIGHT / 2;
    raw[node.id] = { x, y };
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
  }
  // A subgraph keeps its corner; a whole layout starts at the origin.
  let originX = 0;
  let originY = 0;
  if (only !== null) {
    originX = Math.min(...nodes.map((node) => node.position.x));
    originY = Math.min(...nodes.map((node) => node.position.y));
  }
  const out: Record<string, LayoutPoint> = {};
  for (const [id, point] of Object.entries(raw)) {
    out[id] = { x: snap(point.x - minX + originX), y: snap(point.y - minY + originY) };
  }
  return out;
}

function overlaps(a: LayoutPoint, b: LayoutPoint): boolean {
  return (
    Math.abs(a.x - b.x) < LAYOUT_NODE_WIDTH + LAYOUT_NODE_SEP / 2 &&
    Math.abs(a.y - b.y) < LAYOUT_NODE_HEIGHT + LAYOUT_NODE_SEP / 2
  );
}

/**
 * Positions for newly added nodes (`ids`), leaving every other node where it is. When nothing else
 * has been placed the new nodes get a full dagre layout; otherwise each goes one column right of a
 * placed input (or left of a placed output, or below everything), moved down until it overlaps no
 * box. Nodes are placed in order, so a chain of new nodes extends to the right.
 */
export function placeNewNodes(workflow: LayoutGraph, ids: Iterable<string>): Record<string, LayoutPoint> {
  const newIds = new Set(ids);
  const placed = new Map<string, LayoutPoint>();
  for (const node of workflow.nodes) if (!newIds.has(node.id)) placed.set(node.id, { ...node.position });
  const fresh = workflow.nodes.filter((node) => newIds.has(node.id));
  if (fresh.length === 0) return {};
  if (placed.size === 0) {
    const out = autoLayout({ nodes: fresh, edges: workflow.edges });
    // Notes are never laid out: stacked under the graph.
    let bottom = Math.max(-LAYOUT_NODE_HEIGHT - LAYOUT_NODE_SEP, ...Object.values(out).map((point) => point.y));
    for (const node of fresh) {
      if (out[node.id]) continue;
      bottom = snap(bottom + LAYOUT_NODE_HEIGHT + LAYOUT_NODE_SEP);
      out[node.id] = { x: 0, y: bottom };
    }
    return out;
  }

  const out: Record<string, LayoutPoint> = {};
  const stepX = LAYOUT_NODE_WIDTH + LAYOUT_RANK_SEP;
  const stepY = LAYOUT_NODE_HEIGHT + LAYOUT_NODE_SEP;
  for (const node of fresh) {
    const input = workflow.edges.find((edge) => edge.target === node.id && placed.has(edge.source));
    const output = workflow.edges.find((edge) => edge.source === node.id && placed.has(edge.target));
    let candidate: LayoutPoint;
    if (input) {
      const from = placed.get(input.source)!;
      candidate = { x: from.x + stepX, y: from.y };
    } else if (output) {
      const to = placed.get(output.target)!;
      candidate = { x: to.x - stepX, y: to.y };
    } else {
      const boxes = [...placed.values()];
      candidate = {
        x: Math.min(...boxes.map((box) => box.x)),
        y: Math.max(...boxes.map((box) => box.y)) + stepY
      };
    }
    candidate = { x: snap(candidate.x), y: snap(candidate.y) };
    for (let guard = 0; guard < 10_000 && [...placed.values()].some((box) => overlaps(box, candidate)); guard += 1) {
      candidate = { x: candidate.x, y: snap(candidate.y + stepY) };
    }
    placed.set(node.id, candidate);
    out[node.id] = candidate;
  }
  return out;
}
