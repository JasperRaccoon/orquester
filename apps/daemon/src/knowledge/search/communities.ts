/**
 * Communities of an undirected weighted graph by modularity (Louvain: local moving, then
 * aggregation, repeated until nothing moves), made deterministic — nodes are visited in index
 * order, a node stays put unless another community is strictly better, and ties between other
 * communities go to the lowest id — so the same graph always gives the same communities. A last
 * pass splits any community that is not connected (Louvain can leave one) into its components.
 */

export interface WeightedEdge {
  a: number;
  b: number;
  /** Positive; an edge with weight ≤ 0 is ignored. */
  weight: number;
}

/** Gains closer than this are ties (floating-point noise must not decide a move). */
const EPSILON = 1e-12;
/** Local-moving passes per level; Louvain settles in far fewer. */
const MAX_PASSES = 64;

/** One level's graph in adjacency (CSR) form; self-loop weights are kept apart. */
interface Level {
  n: number;
  offsets: Int32Array;
  targets: Int32Array;
  weights: Float64Array;
  self: Float64Array;
  /** Weighted degree: Σ incident weights + 2 · self-loop. */
  degree: Float64Array;
}

function buildLevel(n: number, pairs: Map<number, number>, self: Float64Array): Level {
  const keys = [...pairs.keys()].sort((x, y) => x - y);
  const count = new Int32Array(n + 1);
  for (const key of keys) {
    count[Math.floor(key / n) + 1]! += 1;
    count[(key % n) + 1]! += 1;
  }
  for (let i = 0; i < n; i += 1) count[i + 1]! += count[i]!;
  const offsets = Int32Array.from(count);
  const fill = Int32Array.from(count);
  const targets = new Int32Array(keys.length * 2);
  const weights = new Float64Array(keys.length * 2);
  const degree = new Float64Array(n);
  for (let i = 0; i < n; i += 1) degree[i] = 2 * self[i]!;
  for (const key of keys) {
    const a = Math.floor(key / n);
    const b = key % n;
    const w = pairs.get(key)!;
    targets[fill[a]!] = b;
    weights[fill[a]!] = w;
    fill[a]! += 1;
    targets[fill[b]!] = a;
    weights[fill[b]!] = w;
    fill[b]! += 1;
    degree[a]! += w;
    degree[b]! += w;
  }
  return { n, offsets, targets, weights, self, degree };
}

/**
 * Moves nodes between communities while modularity rises; true when any node moved. Moving u into
 * community c gains w(u, c) − deg(u)·Σdeg(c) / 2m (up to a common factor), with u taken out first.
 */
async function localMoving(level: Level, community: Int32Array, total: number, pause: () => Promise<void>): Promise<boolean> {
  const { n, offsets, targets, weights, degree } = level;
  const sum = Float64Array.from(degree); // Σ degree per community (each node starts alone)
  const toCommunity = new Float64Array(n).fill(-1);
  const touched = new Int32Array(n);
  let movedAny = false;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    let moved = false;
    for (let u = 0; u < n; u += 1) {
      const own = community[u]!;
      const ku = degree[u]!;
      let seen = 0;
      toCommunity[own] = 0;
      touched[seen++] = own;
      for (let e = offsets[u]!; e < offsets[u + 1]!; e += 1) {
        const c = community[targets[e]!]!;
        if (toCommunity[c] === -1) {
          toCommunity[c] = 0;
          touched[seen++] = c;
        }
        toCommunity[c]! += weights[e]!;
      }
      sum[own]! -= ku;
      let best = own;
      let bestGain = toCommunity[own]! - (ku * sum[own]!) / total;
      for (let t = 1; t < seen; t += 1) {
        const c = touched[t]!;
        const gain = toCommunity[c]! - (ku * sum[c]!) / total;
        if (gain > bestGain + EPSILON || (best !== own && gain > bestGain - EPSILON && c < best)) {
          best = c;
          bestGain = gain;
        }
      }
      sum[best]! += ku;
      if (best !== own) {
        community[u] = best;
        moved = true;
      }
      for (let t = 0; t < seen; t += 1) toCommunity[touched[t]!] = -1;
    }
    if (!moved) break;
    movedAny = true;
    await pause();
  }
  return movedAny;
}

/** Renumbers labels 0.. in order of first appearance; returns the count. */
function renumber(labels: Int32Array): number {
  const map = new Map<number, number>();
  for (let i = 0; i < labels.length; i += 1) {
    let id = map.get(labels[i]!);
    if (id === undefined) map.set(labels[i]!, (id = map.size));
    labels[i] = id;
  }
  return map.size;
}

/**
 * Each node's community, numbered 0.. by its first node; nodes without a positive edge are alone.
 * Edges may come in any order and repeat a pair (their weights add up). `pause` is awaited
 * between passes (the caller's event-loop yield).
 */
export async function communities(n: number, edges: readonly WeightedEdge[], pause: () => Promise<void> = async () => {}): Promise<Int32Array> {
  const membership = new Int32Array(n);
  for (let i = 0; i < n; i += 1) membership[i] = i;
  if (n === 0) return membership;

  const pairs = new Map<number, number>();
  for (const { a, b, weight } of edges) {
    if (!(weight > 0) || a === b) continue;
    const key = a < b ? a * n + b : b * n + a;
    pairs.set(key, (pairs.get(key) ?? 0) + weight);
  }
  const base = buildLevel(n, pairs, new Float64Array(n));
  let level = base;
  let total = 0;
  for (let i = 0; i < n; i += 1) total += base.degree[i]!;
  if (total === 0) return membership;

  for (;;) {
    const community = new Int32Array(level.n);
    for (let i = 0; i < level.n; i += 1) community[i] = i;
    if (!(await localMoving(level, community, total, pause))) break;
    const count = renumber(community);
    for (let i = 0; i < n; i += 1) membership[i] = community[membership[i]!]!;
    if (count === level.n) break;
    // Aggregate: one node per community, edges summed, inner edges as self-loops.
    const next = new Map<number, number>();
    const self = new Float64Array(count);
    for (let u = 0; u < level.n; u += 1) {
      const cu = community[u]!;
      self[cu]! += level.self[u]!;
      for (let e = level.offsets[u]!; e < level.offsets[u + 1]!; e += 1) {
        const v = level.targets[e]!;
        if (v < u) continue; // each edge once
        const cv = community[v]!;
        const w = level.weights[e]!;
        if (cu === cv) self[cu]! += w;
        else {
          const key = cu < cv ? cu * count + cv : cv * count + cu;
          next.set(key, (next.get(key) ?? 0) + w);
        }
      }
    }
    level = buildLevel(count, next, self);
    await pause();
  }

  // Connected parts of each community (on the original graph), numbered by first node.
  const out = new Int32Array(n).fill(-1);
  const stack: number[] = [];
  let id = 0;
  for (let start = 0; start < n; start += 1) {
    if (out[start] !== -1) continue;
    out[start] = id;
    stack.push(start);
    while (stack.length > 0) {
      const u = stack.pop()!;
      for (let e = base.offsets[u]!; e < base.offsets[u + 1]!; e += 1) {
        const v = base.targets[e]!;
        if (out[v] === -1 && membership[v] === membership[u]) {
          out[v] = id;
          stack.push(v);
        }
      }
    }
    id += 1;
  }
  return out;
}
