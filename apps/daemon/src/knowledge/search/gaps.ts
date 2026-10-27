/**
 * Link gaps (phase 2 spec, "Link gaps"): pairs of linked entries that are very close in meaning but
 * share no concept, so linking missed what ties them. The re-linker queues both entries; insights
 * lists the pairs. Pure over the ports; yields to the event loop on large sets.
 *
 * Two artefacts are left out (126 real entries: 63 pairs at `strong` before, 15 after):
 *
 * - Concepts are compared by name ({@link linkGapConceptKey}): myKG can extract one thing under two
 *   types ("App Store" as a Channel and as a Platform), and two entries linked to it that way are
 *   linked (18 of the 63).
 * - Hubs: a long guide or a survey is close to nearly everything (its mean vector sits in the
 *   middle of the base), so a pair counts only when it is about as close as each entry's own
 *   nearest neighbours are to it: 2·cos − r(a) − r(b) ≥ −{@link HUB_MARGIN}, r = the mean
 *   similarity to an entry's {@link HUB_NEIGHBOURS} nearest (CSLS, the usual hubness correction).
 *   This drops 30 of the remaining 45 (a 20k-character marketing guide, the contradiction map and
 *   the App Store checklists against short posts), and keeps pairs like an iPhone-permissions post
 *   and the iOS fingerprinting note.
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
  /** The concepts linked to an entry, as {@link linkGapConceptKey}s (empty: not linked yet, never a gap). */
  conceptsOf: (entryId: string) => ReadonlySet<string> | readonly string[];
  /** Similarity at or above which a pair must share a concept (the model's `strong` threshold). */
  minimum: number;
  /** At most this many pairs, closest first (after `exclude`). */
  limit: number;
  /** Pairs left out before the limit applies (`a` < `b`): e.g. the ones a caller already handled. */
  exclude?: (a: string, b: string) => boolean;
  /** Each entry's nearest neighbours considered (default 5). */
  neighbours?: number;
}

const YIELD_EVERY_MS = 40;
/** Nearest entries whose mean similarity is an entry's usual closeness (`r` of the hubness correction). */
const HUB_NEIGHBOURS = 10;
/** How far below its two entries' usual closeness a pair may be and still be a gap. */
const HUB_MARGIN = 0.025;

/** A concept as link gaps compare it: by name, without case, accents or spacing. */
export function linkGapConceptKey(concept: { name: string }): string {
  return concept.name.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

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
  const pause = async (): Promise<void> => {
    if (performance.now() - since < YIELD_EVERY_MS) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    since = performance.now();
  };
  // Each row's nearest neighbours at or above `minimum`, and its usual closeness.
  const near: { j: number; similarity: number }[][] = [];
  const usual = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    const best: { j: number; similarity: number }[] = [];
    /** The HUB_NEIGHBOURS best similarities, best first. */
    const top: number[] = [];
    for (let j = 0; j < rows.length; j += 1) {
      if (j === i) continue;
      const other = rows[j]!.vector;
      let dot = 0;
      for (let d = 0; d < row.vector.length; d += 1) dot += row.vector[d]! * other[d]!;
      if (top.length < HUB_NEIGHBOURS || dot > top[top.length - 1]!) {
        let at = top.length < HUB_NEIGHBOURS ? top.length : HUB_NEIGHBOURS - 1;
        while (at > 0 && top[at - 1]! < dot) {
          top[at] = top[at - 1]!;
          at -= 1;
        }
        top[at] = dot;
      }
      if (dot >= options.minimum) best.push({ j, similarity: dot });
    }
    best.sort((x, y) => y.similarity - x.similarity || x.j - y.j);
    near.push(best.slice(0, neighbours));
    usual[i] = top.length > 0 ? top.reduce((sum, value) => sum + value, 0) / top.length : 0;
    await pause();
  }
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    for (const { j, similarity } of near[i]!) {
      const other = rows[j]!;
      if (2 * similarity - usual[i]! - usual[j]! < -HUB_MARGIN) continue;
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
      if (pairs.has(key) || options.exclude?.(a, b)) continue;
      pairs.set(key, { a, b, similarity });
    }
    await pause();
  }
  return [...pairs.values()].sort((x, y) => y.similarity - x.similarity || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : 1)).slice(0, options.limit);
}
