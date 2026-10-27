/**
 * Link gaps (phase 2 spec, "Link gaps"): pairs of linked entries that are very close in meaning but
 * share no concept, so linking missed what ties them. The re-linker queues both entries; insights
 * lists the pairs. Pure over the ports; yields to the event loop on large sets.
 */

import type { KnowledgeVectorIndex } from "../ports.ts";

export interface KnowledgeLinkGapPair {
  /** Sorted: `a` < `b`. */
  a: string;
  b: string;
  similarity: number;
}

export interface FindLinkGapsOptions {
  /** Candidate entries (already scoped by the caller); only those with vectors and concepts count. */
  ids: readonly string[];
  index: KnowledgeVectorIndex;
  /** The concept ids linked to an entry (empty: not linked yet, never a gap). */
  conceptsOf: (entryId: string) => ReadonlySet<string> | readonly string[];
  /** Similarity at or above which a pair must share a concept (the model's `strong` threshold). */
  minimum: number;
  /** At most this many pairs, closest first. */
  limit: number;
  /** Each entry's nearest neighbours considered (default 5). */
  neighbours?: number;
}

const YIELD_EVERY_MS = 40;

export async function findLinkGaps(options: FindLinkGapsOptions): Promise<KnowledgeLinkGapPair[]> {
  const neighbours = options.neighbours ?? 5;
  const rows: { id: string; vector: Float32Array; concepts: ReadonlySet<string> }[] = [];
  for (const id of options.ids) {
    const vector = options.index.entryVector(id);
    const linked = options.conceptsOf(id);
    const concepts = linked instanceof Set ? (linked as ReadonlySet<string>) : new Set(linked as readonly string[]);
    if (vector && concepts.size > 0) rows.push({ id, vector, concepts });
  }
  const pairs = new Map<string, KnowledgeLinkGapPair>();
  let since = performance.now();
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    const best: { j: number; similarity: number }[] = [];
    for (let j = 0; j < rows.length; j += 1) {
      if (j === i) continue;
      const other = rows[j]!.vector;
      let dot = 0;
      for (let d = 0; d < row.vector.length; d += 1) dot += row.vector[d]! * other[d]!;
      if (dot < options.minimum) continue;
      best.push({ j, similarity: dot });
    }
    best.sort((x, y) => y.similarity - x.similarity || x.j - y.j);
    for (const { j, similarity } of best.slice(0, neighbours)) {
      const other = rows[j]!;
      let shared = false;
      for (const concept of other.concepts) {
        if (row.concepts.has(concept)) {
          shared = true;
          break;
        }
      }
      if (shared) continue;
      const [a, b] = row.id < other.id ? [row.id, other.id] : [other.id, row.id];
      const key = `${a} ${b}`;
      if (!pairs.has(key)) pairs.set(key, { a, b, similarity });
    }
    if (performance.now() - since >= YIELD_EVERY_MS) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      since = performance.now();
    }
  }
  return [...pairs.values()].sort((x, y) => y.similarity - x.similarity || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : 1)).slice(0, options.limit);
}
