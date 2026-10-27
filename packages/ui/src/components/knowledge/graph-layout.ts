// The graph's layout: a force simulation (d3-force), run in a worker
// (`graph-layout.worker.ts`) so the canvas stays responsive. Concepts repel,
// links pull their ends together, and a weak pull to the centre keeps unlinked
// concepts in a halo round the rest; a last pass moves apart any dots still
// touching. The spread-out look of Obsidian's graph view, with no overlaps.
// A graph that grew (entries still being linked) starts from where its dots
// already are, so the picture settles instead of jumping.

import { forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";

export interface LayoutRequest {
  id: number;
  nodes: { id: string; size: number }[];
  edges: { source: string; target: string }[];
  /** Where the concepts already shown are (`warmStart`): the layout starts from there. */
  initial?: Positions;
}

export type LayoutResponse =
  | { id: number; positions: Record<string, { x: number; y: number }> }
  | { id: number; error: string };

interface Body extends SimulationNodeDatum {
  id: string;
  /** Radius. */
  r: number;
}

/** Clear space kept between two dots, beyond their radii. */
const LAYOUT_GAP = 4;
/** Rest length of a link, beyond the radii of its ends. */
const LINK_GAP = 24;
/** Pull towards the centre: what keeps unlinked concepts and small clusters near the rest. */
const GRAVITY = 0.06;
/**
 * Ticks of the simulation. Barnes–Hut with a coarse `THETA` keeps a tick
 * cheap; the simulation's collision force would cost more than the rest
 * together, so `separate` does that job once at the end.
 */
const TICKS = 160;
const THETA = 1.2;
/**
 * How hot a warm start begins (a fresh layout starts at 1): enough to fit the
 * new concepts in, not to reshuffle. On a 2,000-concept graph gaining 49, the
 * others move 2% of its width on average (a fresh layout: 44%).
 */
const WARM_ALPHA = 0.15;
/** Where the simulation counts as cooled: a fresh layout gets there in `TICKS`, a warm one sooner. */
const ALPHA_MIN = 0.001;

/**
 * Positions for every node of `request`. Deterministic: the same request gets
 * the same picture. With `initial`, the concepts it places start there.
 */
export function computeLayout(request: Omit<LayoutRequest, "id">): Record<string, { x: number; y: number }> {
  const warm = request.initial && request.nodes.some((n) => Object.hasOwn(request.initial!, n.id) && request.initial![n.id]);
  const seeds = warm ? seedPositions(request.nodes, request.edges, request.initial!) : null;
  const bodies: Body[] = request.nodes.map((n) => {
    const at = seeds?.[n.id];
    return at ? { id: n.id, r: n.size / 2, x: at.x, y: at.y } : { id: n.id, r: n.size / 2 };
  });
  const ids = new Set(bodies.map((b) => b.id));
  const seen = new Set<string>();
  const links: SimulationLinkDatum<Body>[] = [];
  for (const { source, target } of request.edges) {
    if (source === target || !ids.has(source) || !ids.has(target)) continue;
    const key = source < target ? `${source}\u0000${target}` : `${target}\u0000${source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ source, target });
  }
  forceSimulation(bodies)
    .randomSource(lcg(1))
    .alphaDecay(1 - Math.pow(ALPHA_MIN, 1 / TICKS))
    .force("charge", forceManyBody<Body>().strength((b) => -40 - b.r * 6).theta(THETA))
    .force(
      "link",
      forceLink<Body, SimulationLinkDatum<Body>>(links)
        .id((b) => b.id)
        .distance((l) => (l.source as Body).r + (l.target as Body).r + LINK_GAP)
    )
    .force("x", forceX<Body>(0).strength(GRAVITY))
    .force("y", forceY<Body>(0).strength(GRAVITY))
    .alpha(warm ? WARM_ALPHA : 1)
    .stop()
    .tick(warm ? Math.ceil((TICKS * Math.log(ALPHA_MIN / WARM_ALPHA)) / Math.log(ALPHA_MIN)) : TICKS);
  separate(bodies);
  const positions: Record<string, { x: number; y: number }> = Object.create(null);
  for (const b of bodies) positions[b.id] = { x: b.x ?? 0, y: b.y ?? 0 };
  return { ...positions };
}

/**
 * Where a relayout of `ids` starts: the placed positions of those concepts,
 * when the graph mostly stayed the same (at least half of the new graph was
 * placed, and at least half of what was placed is still in it: entries being
 * linked). Null for a different graph (another filter or focus), which reads
 * better laid out afresh.
 */
export function warmStart(ids: readonly string[], placed: ReadonlyMap<string, { x: number; y: number }>): Positions | null {
  const out: Positions = Object.create(null);
  let kept = 0;
  for (const id of ids) {
    const at = placed.get(id);
    if (!at) continue;
    out[id] = { x: at.x, y: at.y };
    kept += 1;
  }
  return kept > 0 && kept * 2 >= ids.length && kept * 2 >= placed.size ? { ...out } : null;
}

/**
 * A start for every node: its `placed` position, else beside the placed
 * neighbours it links to (rounds out from the placed part, so chains of new
 * concepts follow), else on the halo round the graph where unlinked concepts
 * settle.
 */
export function seedPositions(
  nodes: readonly { id: string; size: number }[],
  edges: readonly { source: string; target: string }[],
  placed: Positions
): Positions {
  const out: Positions = Object.create(null);
  for (const n of nodes) {
    const at = Object.hasOwn(placed, n.id) ? placed[n.id] : undefined;
    if (at) out[n.id] = { x: at.x, y: at.y };
  }
  const neighbours = new Map<string, string[]>();
  for (const { source, target } of edges) {
    if (source === target) continue;
    (neighbours.get(source) ?? neighbours.set(source, []).get(source)!).push(target);
    (neighbours.get(target) ?? neighbours.set(target, []).get(target)!).push(source);
  }
  const direction = (id: string) => {
    const angle = (hash(id) / 4294967296) * 2 * Math.PI;
    return { x: Math.cos(angle), y: Math.sin(angle) };
  };
  const pending = nodes.filter((n) => !out[n.id]);
  // Discover the rounds once. Scanning every remaining node per round makes a
  // long chain quadratic, and this also runs on the main thread before paint.
  const unplaced = new Set(pending.map((n) => n.id));
  const depth = new Map<string, number>();
  // Only positions stored for real concept IDs seed their neighbours.
  const queue = [...neighbours.keys()].filter((id) => Boolean(out[id]));
  for (let i = 0; i < queue.length; i += 1) {
    const id = queue[i]!;
    const nextDepth = (depth.get(id) ?? 0) + 1;
    for (const next of neighbours.get(id) ?? []) {
      if (!unplaced.has(next) || depth.has(next)) continue;
      depth.set(next, nextDepth);
      queue.push(next);
    }
  }
  const rounds: typeof pending[] = [];
  const unlinked: typeof pending = [];
  // Keep the original node order within each round: both the returned property
  // order and the later halo's floating-point sums depend on it.
  for (const n of pending) {
    const d = depth.get(n.id);
    if (d === undefined) unlinked.push(n);
    else (rounds[d - 1] ??= []).push(n);
  }
  for (const batch of rounds) {
    const round: [string, { x: number; y: number }][] = [];
    for (const n of batch) {
      const near = (neighbours.get(n.id) ?? []).flatMap((id) => (out[id] ? [out[id]] : []));
      const away = direction(n.id);
      const reach = n.size / 2 + LINK_GAP;
      round.push([
        n.id,
        {
          x: near.reduce((sum, p) => sum + p.x, 0) / near.length + away.x * reach,
          y: near.reduce((sum, p) => sum + p.y, 0) / near.length + away.y * reach
        }
      ]);
    }
    for (const [id, at] of round) out[id] = at;
  }
  const points = Object.values(out);
  const cx = points.reduce((sum, p) => sum + p.x, 0) / Math.max(1, points.length);
  const cy = points.reduce((sum, p) => sum + p.y, 0) / Math.max(1, points.length);
  const radius = points.reduce((max, p) => Math.max(max, Math.hypot(p.x - cx, p.y - cy)), 0) + LINK_GAP;
  for (const n of unlinked) {
    const away = direction(n.id);
    out[n.id] = { x: cx + away.x * radius, y: cy + away.y * radius };
  }
  return { ...out };
}

/**
 * Moves apart every two dots closer than their radii and `LAYOUT_GAP`, half
 * each way, until none are (or a pass budget runs out). The simulation leaves
 * few such pairs, so a spatial hash finds them in linear time.
 */
function separate(bodies: Body[], passes = 50): void {
  const maxR = bodies.reduce((max, b) => Math.max(max, b.r), 0);
  const cell = 2 * maxR + LAYOUT_GAP;
  for (let pass = 0; pass < passes; pass += 1) {
    const grid = new Map<string, Body[]>();
    for (const b of bodies) {
      const key = `${Math.floor(b.x! / cell)},${Math.floor(b.y! / cell)}`;
      const bucket = grid.get(key);
      if (bucket) bucket.push(b);
      else grid.set(key, [b]);
    }
    let moved = false;
    for (const a of bodies) {
      const cx = Math.floor(a.x! / cell);
      const cy = Math.floor(a.y! / cell);
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (const b of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
            if (b === a || b.id < a.id) continue;
            const min = a.r + b.r + LAYOUT_GAP;
            let ex = b.x! - a.x!;
            let ey = b.y! - a.y!;
            let d = Math.hypot(ex, ey);
            if (d >= min) continue;
            if (d === 0) {
              // Coincident: split them along a direction fixed by their ids.
              const angle = (hash(a.id + b.id) / 4294967296) * 2 * Math.PI;
              ex = Math.cos(angle);
              ey = Math.sin(angle);
              d = 1;
            }
            const push = (min - d) / 2 / d;
            a.x! -= ex * push;
            a.y! -= ey * push;
            b.x! += ex * push;
            b.y! += ey * push;
            moved = true;
          }
        }
      }
    }
    if (!moved) return;
  }
}

/** A seeded generator in [0, 1), for the simulation's jiggle. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
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
 * view is hidden; a refetch laid the graph out meanwhile) — remembers to, and
 * fits when `whenSized` sees a size again. Fitting a zero-size viewport would
 * leave the graph at the minimum zoom when the view comes back.
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
