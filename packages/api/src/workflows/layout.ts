// Automated workflows — automatic layout (the editor's "Tidy up", nodes an agent adds through the
// MCP without a position). dagre, left to right. Positions are React Flow's: a node's TOP-LEFT
// corner, snapped to the editor's 16 px grid.

import dagre from "@dagrejs/dagre";

import { outputHandles } from "./graph.ts";
import type { WorkflowEdge, WorkflowNode } from "./types.ts";

export const LAYOUT_NODE_WIDTH = 240;
export const LAYOUT_NODE_HEIGHT = 96;
/** Column gap: room for a branch's label ("case 2 · Feature") between a card and the next. */
export const LAYOUT_RANK_SEP = 112;
export const LAYOUT_NODE_SEP = 48;
export const LAYOUT_GRID = 16;
/** Extra room above a failure branch, so its dashed edges run clear of the cards above. */
const FAILURE_GAP = 32;

export interface LayoutPoint {
  x: number;
  y: number;
}

type LayoutNode = Pick<WorkflowNode, "id" | "type" | "position"> & { config?: unknown };
type LayoutEdge = Pick<WorkflowEdge, "source" | "sourceHandle" | "target">;
type LayoutGraph = { nodes: readonly LayoutNode[]; edges: readonly LayoutEdge[] };

const snap = (value: number): number => Math.round(value / LAYOUT_GRID) * LAYOUT_GRID;

/** A card's height for layout: taller when it has many labelled outputs (a switch). */
export function layoutNodeHeight(node: Pick<LayoutNode, "type"> & { config?: unknown }): number {
  const handles = outputHandles({ id: "", ...node });
  return LAYOUT_NODE_HEIGHT + Math.max(0, handles.length - 2) * 24;
}

/**
 * The failure side of a graph: blocks only failures lead to — every edge into them leaves by an
 * `error` output, or comes from another block of the failure side. They are laid out apart, below
 * the success path, so its dashed edges never cross it.
 */
export function failureSide(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[]): Set<string> {
  const incoming = new Map<string, LayoutEdge[]>();
  for (const edge of edges) {
    const list = incoming.get(edge.target) ?? [];
    list.push(edge);
    incoming.set(edge.target, list);
  }
  const side = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const node of nodes) {
      if (side.has(node.id)) continue;
      const into = incoming.get(node.id) ?? [];
      if (into.length === 0) continue;
      if (into.every((edge) => edge.sourceHandle === "error" || side.has(edge.source))) {
        side.add(node.id);
        changed = true;
      }
    }
  }
  return side;
}

/** dagre over `nodes` (left to right), each node's TOP-LEFT relative to the drawing's own corner. */
function dagreLayout(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[]): Record<string, LayoutPoint> {
  const ids = new Set(nodes.map((node) => node.id));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const graph = new dagre.graphlib.Graph({ multigraph: false });
  graph.setGraph({ rankdir: "LR", ranksep: LAYOUT_RANK_SEP, nodesep: LAYOUT_NODE_SEP, marginx: 0, marginy: 0 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) graph.setNode(node.id, { width: LAYOUT_NODE_WIDTH, height: layoutNodeHeight(node) });
  // Edges in handle order, so a block's first output (success, true, case:0) tends to sit on top;
  // a failure edge weighs least (it bends, the success path stays straight).
  const sorted = edges
    .filter((edge) => ids.has(edge.source) && ids.has(edge.target) && edge.source !== edge.target)
    .map((edge, index) => {
      const source = byId.get(edge.source)!;
      const rank = outputHandles(source).indexOf(edge.sourceHandle);
      return { edge, index, rank: rank < 0 ? Number.MAX_SAFE_INTEGER : rank };
    })
    .sort((a, b) => a.rank - b.rank || a.index - b.index);
  for (const { edge } of sorted) {
    if (!graph.hasEdge(edge.source, edge.target)) {
      graph.setEdge(edge.source, edge.target, { weight: edge.sourceHandle === "error" ? 1 : 4 });
    }
  }
  dagre.layout(graph);
  const out: Record<string, LayoutPoint> = {};
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (const node of nodes) {
    const laid = graph.node(node.id) as { x: number; y: number } | undefined;
    const x = (laid?.x ?? 0) - LAYOUT_NODE_WIDTH / 2;
    const y = (laid?.y ?? 0) - layoutNodeHeight(node) / 2;
    out[node.id] = { x, y };
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
  }
  for (const point of Object.values(out)) {
    point.x -= minX;
    point.y -= minY;
  }
  return out;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const boxesOverlap = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width + LAYOUT_NODE_SEP / 2 &&
  b.x < a.x + a.width + LAYOUT_NODE_SEP / 2 &&
  a.y < b.y + b.height + LAYOUT_NODE_SEP / 2 &&
  b.y < a.y + a.height + LAYOUT_NODE_SEP / 2;

/**
 * dagre positions for the workflow's nodes (notes are never moved). With `onlyNodeIds`, only that
 * subgraph is laid out and it keeps its top-left corner where it was — "Tidy up" on a selection.
 *
 * The success path is laid out first; each failure branch (`failureSide`) then goes one column
 * right of the rightmost block that fails into it, below the blocks it would otherwise sit among.
 */
export function autoLayout(workflow: LayoutGraph, opts: { onlyNodeIds?: Iterable<string> } = {}): Record<string, LayoutPoint> {
  const only = opts.onlyNodeIds === undefined ? null : new Set(opts.onlyNodeIds);
  const nodes = workflow.nodes.filter((node) => node.type !== "note" && (only === null || only.has(node.id)));
  if (nodes.length === 0) return {};
  const ids = new Set(nodes.map((node) => node.id));
  const edges = workflow.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target) && edge.source !== edge.target);
  const byId = new Map(nodes.map((node) => [node.id, node]));

  const failure = failureSide(nodes, edges);
  const main = nodes.filter((node) => !failure.has(node.id));
  let raw: Record<string, LayoutPoint>;
  if (main.length === 0 || failure.size === 0) {
    raw = dagreLayout(nodes, edges);
  } else {
    raw = dagreLayout(
      main,
      edges.filter((edge) => !failure.has(edge.source) && !failure.has(edge.target))
    );
    const placed: Box[] = main.map((node) => ({ ...raw[node.id]!, width: LAYOUT_NODE_WIDTH, height: layoutNodeHeight(node) }));

    // The failure side's connected parts, each laid out on its own.
    const parts: string[][] = [];
    const seen = new Set<string>();
    for (const node of nodes) {
      if (!failure.has(node.id) || seen.has(node.id)) continue;
      const part: string[] = [];
      const stack = [node.id];
      seen.add(node.id);
      while (stack.length > 0) {
        const id = stack.pop()!;
        part.push(id);
        for (const edge of edges) {
          const other = edge.source === id ? edge.target : edge.target === id ? edge.source : null;
          if (other !== null && failure.has(other) && !seen.has(other)) {
            seen.add(other);
            stack.push(other);
          }
        }
      }
      parts.push(part);
    }
    const feeders = (part: readonly string[]): string[] => {
      const inside = new Set(part);
      return [...new Set(edges.filter((edge) => inside.has(edge.target) && !failure.has(edge.source)).map((edge) => edge.source))];
    };
    const columnOf = (part: readonly string[]): number =>
      Math.max(0, ...feeders(part).map((id) => raw[id]!.x + LAYOUT_NODE_WIDTH + LAYOUT_RANK_SEP));
    parts.sort((a, b) => columnOf(a) - columnOf(b));

    for (const part of parts) {
      const partNodes = part.map((id) => byId.get(id)!);
      const local = dagreLayout(partNodes, edges.filter((edge) => failure.has(edge.source) && failure.has(edge.target)));
      const width = Math.max(...partNodes.map((node) => local[node.id]!.x)) + LAYOUT_NODE_WIDTH;
      const height = Math.max(...partNodes.map((node) => local[node.id]!.y + layoutNodeHeight(node)));
      const sources = feeders(part);
      const left = columnOf(part);
      const from = sources.length > 0 ? Math.min(...sources.map((id) => raw[id]!.x)) : left;
      // Below every card between its leftmost feeder and its own right edge.
      const above = placed.filter((box) => box.x < left + width && box.x + box.width > from);
      let top = above.length > 0 ? Math.max(...above.map((box) => box.y + box.height)) + LAYOUT_NODE_SEP + FAILURE_GAP : 0;
      const step = LAYOUT_NODE_HEIGHT / 2;
      for (let guard = 0; guard < 1_000 && placed.some((box) => boxesOverlap(box, { x: left, y: top, width, height })); guard += 1) {
        top += step;
      }
      for (const node of partNodes) {
        const point = local[node.id]!;
        raw[node.id] = { x: left + point.x, y: top + point.y };
        placed.push({ ...raw[node.id]!, width: LAYOUT_NODE_WIDTH, height: layoutNodeHeight(node) });
      }
    }
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (const point of Object.values(raw)) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
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
      // Beside what that block already feeds (the column the user made), else one column right.
      const siblings = workflow.edges
        .filter((edge) => edge.source === input.source && edge.target !== node.id && placed.has(edge.target))
        .map((edge) => placed.get(edge.target)!)
        .filter((box) => box.x > from.x);
      candidate = { x: siblings.length > 0 ? Math.min(...siblings.map((box) => box.x)) : from.x + stepX, y: from.y };
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
