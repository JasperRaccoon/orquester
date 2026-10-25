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
function spread(
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

export type Positions = Record<string, { x: number; y: number }>;

/** The part of a dedicated `Worker` the layouts use (tests pass a fake). */
export interface LayoutWorkerLike {
  onmessage: ((event: MessageEvent<LayoutResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: LayoutRequest): void;
  terminate(): void;
}

/**
 * Arranges graphs off the main thread, one at a time. New data cancels the
 * layout in flight: a worker still arranging an older graph is terminated
 * (its answer could only be dropped, and the new graph would wait behind it)
 * and a fresh one takes the new request. Without a worker factory it runs inline.
 */
export class Layouts {
  private worker: LayoutWorkerLike | null = null;
  private seq = 0;
  /** The request the worker is arranging; 0 when it is idle. */
  private busy = 0;
  private waiting: ((answer: LayoutResponse) => void) | null = null;

  constructor(private readonly createWorker: (() => LayoutWorkerLike) | null) {}

  run(request: Omit<LayoutRequest, "id">, done: (positions: Positions) => void, failed: (message: string) => void): void {
    this.stopBusyWorker();
    const id = ++this.seq;
    const settle = (answer: LayoutResponse) => {
      if (answer.id !== this.seq) return;
      if ("positions" in answer) done(answer.positions);
      else failed(answer.error);
    };
    if (!this.createWorker) {
      setTimeout(() => {
        if (id !== this.seq) return;
        try {
          settle({ id, positions: computeLayout(request) });
        } catch (error) {
          settle({ id, error: error instanceof Error ? error.message : String(error) });
        }
      }, 16);
      return;
    }
    if (!this.worker) {
      const worker = this.createWorker();
      worker.onmessage = (event: MessageEvent<LayoutResponse>) => {
        if (this.worker !== worker) return;
        if (event.data.id === this.busy) this.busy = 0;
        this.waiting?.(event.data);
      };
      worker.onerror = (event) => {
        event.preventDefault();
        if (this.worker !== worker) return;
        const failedId = this.busy;
        // A worker that threw is not trusted with the next graph.
        this.busy = 0;
        this.worker = null;
        worker.terminate();
        this.waiting?.({ id: failedId, error: event.message || "The layout worker failed." });
      };
      this.worker = worker;
    }
    this.waiting = settle;
    this.busy = id;
    this.worker.postMessage({ id, ...request });
  }

  /** Drop the layout in flight (its worker too, when one is busy with it). */
  cancel(): void {
    this.seq += 1;
    this.stopBusyWorker();
  }

  dispose(): void {
    this.cancel();
    this.worker?.terminate();
    this.worker = null;
  }

  private stopBusyWorker(): void {
    if (this.busy === 0 || !this.worker) return;
    this.worker.terminate();
    this.worker = null;
    this.busy = 0;
  }
}

/** The viewport calls a deferred fit needs (`cytoscape.Core` satisfies it). */
export interface FitTarget {
  width(): number;
  height(): number;
  fit(eles?: undefined, padding?: number): unknown;
}

export const FIT_PADDING = 30;

/**
 * Fits the graph to its container, or — while the container has no size (the
 * tab is hidden; a refetch laid the graph out meanwhile) — remembers to, and
 * fits when `whenSized` sees a size again. Fitting a zero-size viewport would
 * leave the graph at the minimum zoom when the tab comes back.
 */
export class DeferredFit {
  private pending = false;

  fit(cy: FitTarget): void {
    if (cy.width() > 0 && cy.height() > 0) {
      this.pending = false;
      cy.fit(undefined, FIT_PADDING);
    } else this.pending = true;
  }

  whenSized(cy: FitTarget): void {
    if (this.pending) this.fit(cy);
  }
}
