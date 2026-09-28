/**
 * How the canvas frames a workflow (workflows spec §7.5): fitted, but never
 * so small that its cards cannot be read. A small graph never goes below 0.7;
 * a big one may go further out, never below 0.35. On a phone the canvas starts
 * on the first few blocks (the trigger and what follows) at a readable zoom,
 * rather than the whole graph at a size nobody can tap.
 */

import { buildStepOutline, type Workflow } from "@orquester/api";

export interface CanvasFitOptions {
  padding: number;
  maxZoom: number;
  minZoom: number;
  /** Fit only these nodes (a phone's opening frame). */
  nodes?: { id: string }[];
}

/** The graphs this size or smaller keep the readable floor. */
export const SMALL_GRAPH_BLOCKS = 8;

export function canvasFitOptions(
  workflow: Pick<Workflow, "nodes" | "edges">,
  options: { phone?: boolean; /** A run's overlay: the whole run matters more than big cards. */ run?: boolean } = {}
): CanvasFitOptions {
  const blocks = workflow.nodes.filter((node) => node.type !== "note");
  const small = blocks.length <= SMALL_GRAPH_BLOCKS;
  if (options.phone) {
    const first = buildStepOutline(workflow)
      .filter((item) => item.kind === "node" && !item.unreachable)
      .slice(0, 2)
      .map((item) => ({ id: item.nodeId }));
    return { padding: 0.18, maxZoom: 1, minZoom: 0.6, ...(first.length > 0 ? { nodes: first } : {}) };
  }
  if (options.run) return { padding: 0.12, maxZoom: 1, minZoom: 0.3 };
  return { padding: 0.14, maxZoom: 1, minZoom: small ? 0.7 : 0.35 };
}

/**
 * A phone's opening frame: the first step (the trigger) near the left edge,
 * a little above the middle, at a zoom its words can be read at — the next
 * blocks run off to the right, inviting a pan. `null` for an empty graph.
 */
export function phoneOpeningViewport(
  workflow: Pick<Workflow, "nodes" | "edges">,
  box: { width: number; height: number },
  zoom = 0.85
): { x: number; y: number; zoom: number } | null {
  const first = buildStepOutline(workflow).find((item) => item.kind === "node");
  const node = first ? workflow.nodes.find((candidate) => candidate.id === first.nodeId) : workflow.nodes[0];
  if (!node) return null;
  return {
    x: Math.round(20 - node.position.x * zoom),
    y: Math.round(box.height * 0.36 - (node.position.y + 36) * zoom),
    zoom
  };
}
