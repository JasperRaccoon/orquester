/**
 * Pure commit-graph layout (no React). Turns a flat, newest-first commit list
 * into per-row lane assignments and drawing instructions for the gitk-style
 * graph gutter in the History panel.
 */

/** Stable per-lane color cycle (blue, emerald, amber, pink, violet, cyan, orange, lime). */
export const LANE_COLORS = [
  "#60a5fa",
  "#34d399",
  "#fbbf24",
  "#f472b6",
  "#a78bfa",
  "#22d3ee",
  "#fb923c",
  "#a3e635"
];

export const laneColor = (index: number): string => LANE_COLORS[index % LANE_COLORS.length];

/**
 * The only commit fields the layout needs — `GitLogEntry` satisfies this.
 * `parents` is optional on purpose: a payload from a daemon older than the `%P`
 * log format has no such field, and a missing-shape crash here reaches the root
 * error boundary and blanks the whole app. Absent parents lay out as roots.
 */
export interface GraphCommit {
  sha: string;
  parents?: string[];
}

/** A drawable instruction for one row's local SVG (coordinates resolved at render time from `col`/half). */
export type GraphSegment =
  | { kind: "line"; col: number; colorIndex: number; half: "top" | "bottom" | "full" }
  | { kind: "curve"; fromCol: number; toCol: number; colorIndex: number; half: "bottom" }
  | { kind: "dot"; col: number; colorIndex: number; isMerge: boolean; isRoot: boolean; isTip: boolean };

export interface GraphRow<T extends GraphCommit> {
  commit: T;
  col: number;
  colorIndex: number;
  segments: GraphSegment[];
}

export interface GraphLayout<T extends GraphCommit> {
  rows: GraphRow<T>[];
  /** Number of lanes any row touches — the gutter's width in lanes. */
  maxLanes: number;
}

interface LaneState {
  sha: string | null;
  colorIndex: number;
}

interface GraphEdge {
  fromCol: number;
  toCol: number;
  colorIndex: number;
}

/**
 * Assigns each commit a lane (column) and produces per-row drawing segments for a
 * DAG graph, in the classic "gitk"-style single pass: lanes are never shifted once
 * created (only freed and reused), so rendering never has to re-flow earlier rows.
 *
 * The one subtlety that isn't obvious from a first pass: two different children can
 * name the *same* parent hash (an ordinary fork point). Naively, both would try to
 * claim their own lane for it. This checks for an existing lane before opening a new
 * one for *every* parent (first or merge), so forks converge into one lane instead of
 * leaving a stale, never-consumed duplicate.
 *
 * The input must be in `git log` order (a child before its parents). A list whose
 * parent links are broken (a filtered view) still lays out — every commit is a
 * fresh tip in its own lane — but the caller should render bare dots instead,
 * since the lanes then mean nothing.
 */
export function layoutGraph<T extends GraphCommit>(commits: T[]): GraphLayout<T> {
  const lanes: LaneState[] = [];
  const rows: GraphRow<T>[] = [];
  let colorCounter = 0;

  const findFreeLane = (): number => {
    const idx = lanes.findIndex((lane) => lane.sha === null);
    if (idx !== -1) return idx;
    lanes.push({ sha: null, colorIndex: 0 });
    return lanes.length - 1;
  };

  for (const commit of commits) {
    let col = lanes.findIndex((lane) => lane.sha === commit.sha);
    let colorIndex: number;
    const isTip = col === -1;
    if (isTip) {
      col = findFreeLane();
      colorIndex = colorCounter++ % LANE_COLORS.length;
    } else {
      colorIndex = lanes[col].colorIndex;
    }

    const lanesBefore = lanes.map((lane) => ({ ...lane }));
    lanes[col] = { sha: null, colorIndex };

    const edgesOut: GraphEdge[] = [];
    // `?? []` — see GraphCommit: an older daemon's log entries carry no parents.
    const parents = commit.parents ?? [];
    const [firstParent, ...restParents] = parents;

    if (firstParent) {
      const existing = lanes.findIndex((lane) => lane.sha === firstParent);
      if (existing !== -1 && existing !== col) {
        edgesOut.push({ fromCol: col, toCol: existing, colorIndex: lanes[existing].colorIndex });
      } else {
        lanes[col] = { sha: firstParent, colorIndex };
        edgesOut.push({ fromCol: col, toCol: col, colorIndex });
      }
    }
    for (const parentSha of restParents) {
      const existing = lanes.findIndex((lane) => lane.sha === parentSha);
      if (existing !== -1) {
        edgesOut.push({ fromCol: col, toCol: existing, colorIndex: lanes[existing].colorIndex });
      } else {
        const free = findFreeLane();
        const mergeColor = colorCounter++ % LANE_COLORS.length;
        lanes[free] = { sha: parentSha, colorIndex: mergeColor };
        edgesOut.push({ fromCol: col, toCol: free, colorIndex: mergeColor });
      }
    }

    const segments: GraphSegment[] = [];
    // Only the consumed commit's lane is replaced on this row. A parent that was
    // already waiting in another lane must keep its vertical line as well as
    // receive the joining curve; otherwise merge lines appear to stop halfway.
    const replaced = new Set<number>([col]);

    // Passthrough verticals for every unchanged lane still alive on both sides of this row.
    const maxLen = Math.max(lanesBefore.length, lanes.length);
    for (let i = 0; i < maxLen; i++) {
      if (replaced.has(i)) continue;
      const before = lanesBefore[i];
      const after = lanes[i];
      if (before?.sha && after?.sha && before.sha === after.sha) {
        segments.push({ kind: "line", col: i, colorIndex: before.colorIndex, half: "full" });
      }
    }

    // Incoming half: a line from above only if this lane was already expected (not a fresh tip).
    if (!isTip) {
      segments.push({ kind: "line", col, colorIndex, half: "top" });
    }

    // Outgoing half(s): straight for a same-column continuation, a curve for a lane change.
    for (const edge of edgesOut) {
      if (edge.fromCol === edge.toCol) {
        segments.push({ kind: "line", col: edge.toCol, colorIndex: edge.colorIndex, half: "bottom" });
      } else {
        segments.push({
          kind: "curve",
          fromCol: edge.fromCol,
          toCol: edge.toCol,
          colorIndex: edge.colorIndex,
          half: "bottom"
        });
      }
    }

    segments.push({
      kind: "dot",
      col,
      colorIndex,
      isMerge: parents.length > 1,
      isRoot: parents.length === 0,
      isTip
    });

    rows.push({ commit, col, colorIndex, segments });
  }

  const maxLanes = rows.reduce((max, row) => {
    const cols = row.segments.flatMap((segment) =>
      segment.kind === "curve" ? [segment.fromCol, segment.toCol] : [segment.col]
    );
    return Math.max(max, ...cols, 0);
  }, 0);

  return { rows, maxLanes: maxLanes + 1 };
}
