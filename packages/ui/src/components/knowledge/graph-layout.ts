/// <reference path="../../types/cytoscape-fcose.d.ts" />
// The graph's layout: fCoSE on a headless Cytoscape, so it can run in a worker
// (`graph-layout.worker.ts`) while the canvas stays responsive. A few thousand
// concepts take seconds to arrange; the main thread runs it only where no
// worker can.

import cytoscape from "cytoscape";
import fcose from "cytoscape-fcose";

cytoscape.use(fcose);

export interface LayoutRequest {
  id: number;
  nodes: { id: string; size: number }[];
  edges: { source: string; target: string }[];
}

export type LayoutResponse =
  | { id: number; positions: Record<string, { x: number; y: number }> }
  | { id: number; error: string };

function options(count: number): cytoscape.LayoutOptions {
  return {
    name: "fcose",
    // The spectral pass alone arranges 2,000 concepts in about 2 s; the force pass
    // on top costs ~10 s at 500 (measured headless), so only small graphs get it.
    quality: count > 150 ? "draft" : "default",
    randomize: true,
    animate: false,
    fit: false,
    nodeDimensionsIncludeLabels: false,
    packComponents: true,
    nodeRepulsion: () => 6500,
    idealEdgeLength: () => 70,
    numIter: 2500
  } as cytoscape.LayoutOptions;
}

/** Positions for every node of `request`. */
export function computeLayout(request: Omit<LayoutRequest, "id">): Record<string, { x: number; y: number }> {
  const ids = new Set(request.nodes.map((n) => n.id));
  const cy = cytoscape({
    headless: true,
    styleEnabled: true,
    style: [{ selector: "node", style: { width: "data(size)", height: "data(size)" } }],
    elements: [
      ...request.nodes.map((n) => ({ group: "nodes" as const, data: { id: n.id, size: n.size } })),
      ...request.edges
        .filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target)
        .map((e, i) => ({ group: "edges" as const, data: { id: `l${i}`, source: e.source, target: e.target } }))
    ]
  });
  cy.layout(options(request.nodes.length)).run();
  const positions: Record<string, { x: number; y: number }> = {};
  cy.nodes().forEach((n) => {
    const { x, y } = n.position();
    positions[n.id()] = { x, y };
  });
  cy.destroy();
  return spread(positions, request.nodes);
}

/** Room each concept gets, in multiples of the mean diameter. */
const SPACING = 2.4;

/**
 * The spectral pass packs a big graph into a fixed area, so its concepts
 * overlap: scale it about its centre until each has room. Never shrinks.
 */
export function spread(
  positions: Record<string, { x: number; y: number }>,
  nodes: readonly { size: number }[]
): Record<string, { x: number; y: number }> {
  const points = Object.values(positions);
  if (points.length < 2) return positions;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { x, y } of points) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const side = Math.sqrt(Math.max(1, (maxX - minX) * (maxY - minY)));
  const meanSize = nodes.reduce((sum, n) => sum + n.size, 0) / Math.max(1, nodes.length);
  const wanted = Math.sqrt(points.length) * meanSize * SPACING;
  const scale = wanted / side;
  if (!(scale > 1)) return positions;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const out: Record<string, { x: number; y: number }> = {};
  for (const [id, { x, y }] of Object.entries(positions)) out[id] = { x: cx + (x - cx) * scale, y: cy + (y - cy) * scale };
  return out;
}
