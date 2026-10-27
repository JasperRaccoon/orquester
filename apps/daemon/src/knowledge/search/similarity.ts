/**
 * Entry-to-entry similarity (retrieval spec docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md):
 *
 * - "Similar entries and possible duplicates (R5)" — {@link KnowledgeSimilarity.forEntry};
 * - "Near-duplicates on save (R6)" — {@link KnowledgeSimilarity.similarForSaved};
 * - "Similarity graph (R7)" — {@link KnowledgeSimilarity.graph}.
 *
 * Vectors are read only through the {@link KnowledgeVectorIndex} port (entry vectors are
 * L2-normalized means, so a dot product is the cosine). Every result is scoped: only entries the
 * caller can see are compared, listed or drawn, and an entry is never similar to itself.
 */

import { createHash } from "node:crypto";
import {
  KNOWLEDGE_SIMILARITY_GRAPH_DEFAULT_K,
  KNOWLEDGE_SIMILARITY_GRAPH_DEFAULT_NODES,
  KNOWLEDGE_SIMILARITY_GRAPH_MAX_K,
  KNOWLEDGE_SIMILARITY_GRAPH_MAX_NODES,
  knowledgeCitation,
  type KnowledgeConceptRef,
  type KnowledgeEntryMeta,
  type KnowledgeEntrySummary,
  type KnowledgeRelatedReason,
  type KnowledgeSaveResult,
  type KnowledgeSimilarEntry,
  type KnowledgeSimilarityCluster,
  type KnowledgeSimilarityEdge,
  type KnowledgeSimilarityGraphResponse
} from "@orquester/api";
import type { KnowledgeStorePort, KnowledgeVectorIndex, KnowledgeVectorThresholds } from "../ports.ts";
import { type WeightedEdge, communities } from "./communities.ts";
import { normalizeAuthor } from "./filters.ts";
import type { KnowledgeGraph } from "./graph.ts";
import { tokenize } from "./text.ts";
import { type KnowledgeScope, entryInScope, visibleCollections } from "./visibility.ts";

/** `similar` on an entry (all reasons together). */
const KNOWLEDGE_SIMILAR_MAX = 8;
/** `possibleDuplicates` on an entry. */
const KNOWLEDGE_DUPLICATES_MAX = 3;
/** Same-author entries considered for `similar`. */
const SAME_AUTHOR_MAX = 2;
/** Shared concepts named in a `concepts` reason. */
const SHARED_CONCEPTS_NAMED = 3;
/** `similar` on a saved entry. */
const KNOWLEDGE_SAVE_SIMILAR_MAX = 3;
/** Neighbours per node the spanning forest chooses from (at least `k`). */
const TREE_CANDIDATES = 8;
/** Work between two yields to the event loop while drawing the graph (spec: at most every 50 ms). */
const YIELD_EVERY_MS = 40;
/** Similarity graphs kept (per scope, k, limit, index generation, graph revision and node set). */
const GRAPH_CACHE_SIZE = 8;
/**
 * How the graph's clusters and labels are made; part of the cache key, so a daemon never serves a
 * graph drawn by an older rule. Bump it whenever clustering or labelling changes.
 */
const GRAPH_ALGORITHM = "communities-v1";
/**
 * The exponent on a cluster edge's rescaled similarity ({@link clusterWeight}): squaring widens
 * the gap between a close neighbour and a loose one, which the narrow cone of e5-style models
 * (any two entries at 0.73–0.99) otherwise flattens.
 */
const CLUSTER_WEIGHT_POWER = 2;
/**
 * Each node's nearest neighbours the clusters are found over (whatever `k` is drawn, so the
 * clusters do not change with it). Few on purpose: with 8, the many loose links between
 * neighbouring topics outweigh the close ones within them and modularity merges the topics (126
 * real entries: SEO, marketing playbooks and pricing as one cluster of 51); with 4 they separate.
 */
const CLUSTER_NEIGHBOURS = 4;
/** Concept types that say who wrote or published entries, not what they are about: never a cluster label. */
const NON_TOPIC_CONCEPT_TYPES: ReadonlySet<string> = new Set(["person", "organization", "company"]);

/**
 * A candidate edge's weight for clustering: its similarity rescaled from [minimum, 1] to [0, 1],
 * squared. Below the model's `minimum` two entries are unrelated, so the scale starts there rather
 * than at 0 — with e5's 0.78 floor a 0.83 (`good`) neighbour weighs 0.05, a 0.90 one 0.30 and a
 * 0.95 one 0.59, where raw cosines would weigh them 0.83, 0.90 and 0.95, nearly alike.
 */
function clusterWeight(similarity: number, minimum: number): number {
  const scaled = (similarity - minimum) / (1 - minimum);
  return scaled > 0 ? scaled ** CLUSTER_WEIGHT_POWER : 0;
}

/** A label compared without case or spacing ("App Store" as a Channel and as a Platform are one). */
const labelKey = (name: string): string => name.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();

export type KnowledgeSavedSimilar = NonNullable<KnowledgeSaveResult["similar"]>[number];

export interface KnowledgeSimilarityOptions {
  store: Pick<KnowledgeStorePort, "listMeta" | "getMeta">;
  graph: Pick<KnowledgeGraph, "relatedEntries" | "conceptsOfEntry" | "revision">;
  /** The vector index, read per call; null while there is none. */
  index: () => KnowledgeVectorIndex | null;
  /** An entry as the read views show it (snippet, visible collections, link count, citation). */
  summary: (meta: KnowledgeEntryMeta, scope: KnowledgeScope) => KnowledgeEntrySummary;
}

interface Candidate {
  meta: KnowledgeEntryMeta;
  similarity: number | null;
  concepts: { refs: KnowledgeConceptRef[]; shared: number } | null;
  author: string | null;
}

/**
 * The drawn entries' title tokens (one map per entry: token → the word it came from, lowercased)
 * and in how many titles each token occurs.
 */
interface TitleStats {
  tokens: Map<string, string>[];
  df: Map<string, number>;
}

/** A title's tokens (`tokenize`), each with the lowercased word it was made from ("ads" for "ad"). */
function titleTokens(title: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const word of title.normalize("NFC").match(/[\p{L}\p{N}]+/gu) ?? []) {
    const token = tokenize(word)[0];
    if (token !== undefined && !out.has(token)) out.set(token, word.toLowerCase());
  }
  return out;
}

/** What the similarity graph caches: everything but the per-request node fields. */
interface GraphStructure {
  /** Drawn entries, most recent first (index = position in every array below). */
  ids: string[];
  cluster: Int32Array;
  degree: Int32Array;
  edges: KnowledgeSimilarityEdge[];
  clusters: KnowledgeSimilarityCluster[];
}

function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += a[i]! * b[i]!;
  return sum;
}

const round = (value: number): number => Math.round(value * 1e4) / 1e4;

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(Math.floor(value), max));
}

function newestFirst(a: KnowledgeEntryMeta, b: KnowledgeEntryMeta): number {
  return b.savedAt.localeCompare(a.savedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** A stable key for what a scope lets through. */
function scopeKey(scope: KnowledgeScope): string {
  const sorted = (set: ReadonlySet<string> | null) => (set ? [...set].sort() : null);
  return JSON.stringify([sorted(scope.canSee), sorted(scope.filter), scope.unfiled, [...scope.known].sort()]);
}

class UnionFind {
  private readonly parent: Int32Array;
  private readonly size: Int32Array;

  constructor(n: number) {
    this.parent = new Int32Array(n);
    this.size = new Int32Array(n).fill(1);
    for (let i = 0; i < n; i += 1) this.parent[i] = i;
  }

  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root]!;
    while (this.parent[x] !== root) {
      const next = this.parent[x]!;
      this.parent[x] = root;
      x = next;
    }
    return root;
  }

  /** Joins the two sets; false when they already were one. */
  union(a: number, b: number): boolean {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return false;
    if (this.size[ra]! < this.size[rb]!) [ra, rb] = [rb, ra];
    this.parent[rb] = ra;
    this.size[ra]! += this.size[rb]!;
    return true;
  }
}

/** Gives the event loop a turn once `YIELD_EVERY_MS` of work has passed since the last one. */
function yielder(): () => Promise<void> {
  let since = performance.now();
  return async () => {
    if (performance.now() - since < YIELD_EVERY_MS) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    since = performance.now();
  };
}

export class KnowledgeSimilarity {
  private readonly store: KnowledgeSimilarityOptions["store"];
  private readonly knowledgeGraph: KnowledgeSimilarityOptions["graph"];
  private readonly index: () => KnowledgeVectorIndex | null;
  private readonly summary: KnowledgeSimilarityOptions["summary"];
  /** Insertion order is least recently used first. */
  private readonly graphCache = new Map<string, Promise<GraphStructure>>();

  constructor(options: KnowledgeSimilarityOptions) {
    this.store = options.store;
    this.knowledgeGraph = options.graph;
    this.index = options.index;
    this.summary = options.summary;
  }

  /** The index with its model's thresholds, or null while embeddings are unavailable. */
  private vectors(): { index: KnowledgeVectorIndex; thresholds: KnowledgeVectorThresholds } | null {
    const index = this.index();
    const thresholds = index?.thresholds() ?? null;
    return index && thresholds ? { index, thresholds } : null;
  }

  private visibleMeta(id: string, scope: KnowledgeScope): KnowledgeEntryMeta | null {
    const meta = this.store.getMeta(id);
    return meta && entryInScope(meta, scope) ? meta : null;
  }

  // -------------------------------------------------------------------------
  // R5: similar entries and possible duplicates
  // -------------------------------------------------------------------------

  /**
   * The entry's `similar` and `possibleDuplicates` (spec R5): the union of its nearest entries by
   * meaning (cosine ≥ `good`, up to 8), the entries sharing concepts with it, and the 2 most recent
   * by the same author or handle; each with every reason that applies; ordered by similarity (none
   * last), shared concepts, then newest; at most 8. Duplicates: up to 3 at cosine ≥ `duplicate`.
   * Only entries `scope` lets through; never the entry itself.
   */
  forEntry(id: string, scope: KnowledgeScope): { similar: KnowledgeSimilarEntry[]; possibleDuplicates: KnowledgeSimilarEntry[] } {
    const meta = this.store.getMeta(id);
    if (!meta) return { similar: [], possibleDuplicates: [] };
    const vectors = this.vectors();
    const own = vectors ? vectors.index.entryVector(id) : null;
    const candidates = new Map<string, Candidate>();
    const candidate = (other: KnowledgeEntryMeta): Candidate => {
      let found = candidates.get(other.id);
      if (!found) candidates.set(other.id, (found = { meta: other, similarity: null, concepts: null, author: null }));
      return found;
    };

    // (a) Nearest by meaning.
    let neighbours: { meta: KnowledgeEntryMeta; similarity: number }[] = [];
    if (vectors && own) {
      for (const other of vectors.index.embeddedIds()) {
        if (other === id) continue;
        const otherMeta = this.visibleMeta(other, scope);
        const vector = otherMeta ? vectors.index.entryVector(other) : null;
        if (!otherMeta || !vector) continue;
        const similarity = dot(own, vector);
        if (similarity >= vectors.thresholds.good) neighbours.push({ meta: otherMeta, similarity });
      }
      neighbours = neighbours.sort((a, b) => b.similarity - a.similarity || newestFirst(a.meta, b.meta));
      for (const neighbour of neighbours.slice(0, KNOWLEDGE_SIMILAR_MAX)) candidate(neighbour.meta).similarity = neighbour.similarity;
    }

    // (b) Shared concepts.
    const ownConcepts = this.knowledgeGraph.conceptsOfEntry(id);
    for (const related of this.knowledgeGraph.relatedEntries(id, scope, KNOWLEDGE_SIMILAR_MAX)) {
      if (related.id === id) continue;
      const otherMeta = this.visibleMeta(related.id, scope);
      if (!otherMeta) continue;
      const theirs = new Set(this.knowledgeGraph.conceptsOfEntry(related.id).map((c) => c.id));
      const refs = ownConcepts.filter((c) => theirs.has(c.id)).slice(0, SHARED_CONCEPTS_NAMED);
      candidate(otherMeta).concepts = { refs, shared: related.shared };
    }

    // (c) The same author or handle, most recent first.
    const handle = meta.handle ? normalizeAuthor(meta.handle) : null;
    const author = meta.author ? normalizeAuthor(meta.author) : null;
    if (handle || author) {
      const same: { meta: KnowledgeEntryMeta; value: string }[] = [];
      for (const other of this.store.listMeta()) {
        if (other.id === id || !entryInScope(other, scope)) continue;
        if (handle && other.handle && normalizeAuthor(other.handle) === handle) same.push({ meta: other, value: other.handle.trim().replace(/^@+/, "") });
        else if (author && other.author && normalizeAuthor(other.author) === author) same.push({ meta: other, value: other.author.replace(/\s+/g, " ").trim() });
      }
      same.sort((a, b) => newestFirst(a.meta, b.meta));
      for (const { meta: otherMeta, value } of same.slice(0, SAME_AUTHOR_MAX)) candidate(otherMeta).author = value;
    }

    // Every candidate's similarity, when both have vectors (it orders them even below `good`).
    if (vectors && own) {
      const known = new Map(neighbours.map((n) => [n.meta.id, n.similarity]));
      for (const found of candidates.values()) {
        if (found.similarity !== null) continue;
        const similarity = known.get(found.meta.id) ?? this.cosine(vectors.index, own, found.meta.id);
        found.similarity = similarity;
      }
    }

    const toWire = (found: Candidate): KnowledgeSimilarEntry => {
      const reasons: KnowledgeRelatedReason[] = [];
      if (vectors && found.similarity !== null && found.similarity >= vectors.thresholds.good) {
        reasons.push({ kind: "meaning", similarity: round(found.similarity) });
      }
      if (found.concepts) reasons.push({ kind: "concepts", concepts: found.concepts.refs.map((c) => ({ ...c })), shared: found.concepts.shared });
      if (found.author !== null) reasons.push({ kind: "author", value: found.author });
      return { entry: this.summary(found.meta, scope), similarity: found.similarity === null ? null : round(found.similarity), reasons };
    };

    const ordered = [...candidates.values()].sort(
      (a, b) =>
        (b.similarity ?? -Infinity) - (a.similarity ?? -Infinity) ||
        (b.concepts?.shared ?? 0) - (a.concepts?.shared ?? 0) ||
        newestFirst(a.meta, b.meta)
    );
    const duplicate = vectors?.thresholds.duplicate ?? Infinity;
    return {
      similar: ordered.slice(0, KNOWLEDGE_SIMILAR_MAX).map(toWire),
      possibleDuplicates: neighbours
        .filter((n) => n.similarity >= duplicate)
        .slice(0, KNOWLEDGE_DUPLICATES_MAX)
        .map((n) => toWire(candidates.get(n.meta.id)!))
    };
  }

  private cosine(index: KnowledgeVectorIndex, own: Float32Array, other: string): number | null {
    const vector = index.entryVector(other);
    return vector ? dot(own, vector) : null;
  }

  // -------------------------------------------------------------------------
  // R6: near-duplicates on save
  // -------------------------------------------------------------------------

  /**
   * For each of `entryIds` (entries one save just created) that has vectors: up to 3 entries
   * `scope` lets through, not among `entryIds`, at cosine ≥ the model's `duplicate` threshold,
   * closest first. Entries without vectors (not embedded within the save's wait) get `[]`.
   */
  similarForSaved(entryIds: readonly string[], scope: KnowledgeScope): Map<string, KnowledgeSavedSimilar[]> {
    const out = new Map<string, KnowledgeSavedSimilar[]>(entryIds.map((id) => [id, []]));
    const vectors = this.vectors();
    if (!vectors || entryIds.length === 0) return out;
    const exclude = new Set(entryIds);
    let pool: { meta: KnowledgeEntryMeta; vector: Float32Array }[] | null = null;
    for (const id of exclude) {
      const own = vectors.index.entryVector(id);
      if (!own) continue;
      pool ??= vectors.index.embeddedIds().flatMap((other) => {
        if (exclude.has(other)) return [];
        const meta = this.visibleMeta(other, scope);
        const vector = meta ? vectors.index.entryVector(other) : null;
        return meta && vector ? [{ meta, vector }] : [];
      });
      const close: { meta: KnowledgeEntryMeta; similarity: number }[] = [];
      for (const other of pool) {
        const similarity = dot(own, other.vector);
        if (similarity >= vectors.thresholds.duplicate) close.push({ meta: other.meta, similarity });
      }
      close.sort((a, b) => b.similarity - a.similarity || newestFirst(a.meta, b.meta));
      out.set(
        id,
        close.slice(0, KNOWLEDGE_SAVE_SIMILAR_MAX).map(({ meta, similarity }) => ({
          entryId: meta.id,
          title: meta.title,
          similarity: round(similarity),
          citation: knowledgeCitation(meta)
        }))
      );
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // R7: the similarity graph
  // -------------------------------------------------------------------------

  /**
   * The similarity layer (spec R7) over the entries `scope` lets through: the most recent `limit`
   * embedded ones as nodes; each node's top-`k` neighbours (cosine ≥ `minimum`) as edges, plus a
   * maximum spanning forest over each node's top-max(k, 8) neighbours (`tree: true`); clusters =
   * modularity communities ({@link communities}) over each node's top-4 neighbours weighted by
   * {@link clusterWeight}, largest first, labelled by {@link clusterLabels}. Cached per algorithm,
   * scope, k, limit, index generation, graph revision and drawn entries; yields to the event loop
   * while it computes.
   */
  async graph(query: { k?: number; limit?: number }, scope: KnowledgeScope): Promise<KnowledgeSimilarityGraphResponse> {
    const k = clamp(query.k, KNOWLEDGE_SIMILARITY_GRAPH_DEFAULT_K, 1, KNOWLEDGE_SIMILARITY_GRAPH_MAX_K);
    const limit = clamp(query.limit, KNOWLEDGE_SIMILARITY_GRAPH_DEFAULT_NODES, 1, KNOWLEDGE_SIMILARITY_GRAPH_MAX_NODES);
    const visible = this.store.listMeta().filter((meta) => entryInScope(meta, scope));
    const vectors = this.vectors();
    if (!vectors) return { nodes: [], edges: [], clusters: [], truncated: false, totals: { entries: visible.length, embedded: 0 } };

    const embeddedIds = new Set(vectors.index.embeddedIds());
    const embedded = visible.filter((meta) => embeddedIds.has(meta.id)).sort(newestFirst);
    const kept = embedded.slice(0, limit);
    const fingerprint = createHash("sha256");
    for (const meta of kept) fingerprint.update(`${meta.id}\u0000${meta.updatedAt}\u0000${meta.title}\u0001`);
    const key = JSON.stringify([
      GRAPH_ALGORITHM,
      scopeKey(scope),
      k,
      limit,
      vectors.index.modelId(),
      vectors.thresholds,
      vectors.index.generation(),
      this.knowledgeGraph.revision(),
      fingerprint.digest("base64")
    ]);

    let structure = this.graphCache.get(key);
    if (structure) {
      this.graphCache.delete(key); // most recently used last
      this.graphCache.set(key, structure);
    } else {
      structure = this.computeGraph(kept, k, vectors.index, vectors.thresholds);
      this.graphCache.set(key, structure);
      while (this.graphCache.size > GRAPH_CACHE_SIZE) this.graphCache.delete(this.graphCache.keys().next().value!);
      structure.catch(() => {
        if (this.graphCache.get(key) === structure) this.graphCache.delete(key);
      });
    }
    const built = await structure;

    // An entry deleted or moved out of view while the graph was computed is left out, with its edges.
    const nodes = built.ids.flatMap((id, i) => {
      const meta = this.store.getMeta(id);
      if (!meta || !entryInScope(meta, scope)) return [];
      return [
        {
          id,
          title: meta.title,
          kind: meta.kind,
          author: meta.author,
          handle: meta.handle,
          savedAt: meta.savedAt,
          collections: visibleCollections(meta, scope),
          cluster: built.cluster[i]!,
          degree: built.degree[i]!
        }
      ];
    });
    const drawn = nodes.length === built.ids.length ? null : new Set(nodes.map((node) => node.id));
    return {
      nodes,
      edges: built.edges.filter((edge) => !drawn || (drawn.has(edge.from) && drawn.has(edge.to))).map((edge) => ({ ...edge })),
      clusters: built.clusters.map((cluster) => ({ ...cluster })),
      truncated: embedded.length > limit,
      totals: { entries: visible.length, embedded: embedded.length }
    };
  }

  private async computeGraph(
    kept: readonly KnowledgeEntryMeta[],
    k: number,
    index: KnowledgeVectorIndex,
    thresholds: KnowledgeVectorThresholds
  ): Promise<GraphStructure> {
    const pause = yielder();
    const drawn: KnowledgeEntryMeta[] = [];
    const rows: Float32Array[] = [];
    for (const meta of kept) {
      const vector = index.entryVector(meta.id);
      if (!vector) continue;
      drawn.push(meta);
      rows.push(vector);
    }
    const n = drawn.length;
    const dims = rows.reduce((max, row) => Math.max(max, row.length), 0);
    const packed = new Float32Array(n * dims);
    rows.forEach((row, i) => packed.set(row, i * dims));

    // Each node's best `keep` neighbours at or above `minimum`, best first (earlier offers win ties).
    const keep = Math.max(k, TREE_CANDIDATES);
    const topIndex = new Int32Array(n * keep).fill(-1);
    const topSim = new Float64Array(n * keep);
    const topCount = new Int32Array(n);
    const offer = (node: number, other: number, similarity: number): void => {
      const base = node * keep;
      let at = topCount[node]!;
      if (at < keep) topCount[node] = at + 1;
      else if (similarity > topSim[base + keep - 1]!) at = keep - 1;
      else return;
      while (at > 0 && topSim[base + at - 1]! < similarity) {
        topSim[base + at] = topSim[base + at - 1]!;
        topIndex[base + at] = topIndex[base + at - 1]!;
        at -= 1;
      }
      topSim[base + at] = similarity;
      topIndex[base + at] = other;
    };
    const minimum = thresholds.minimum;
    for (let i = 0; i < n; i += 1) {
      const a = i * dims;
      for (let j = i + 1; j < n; j += 1) {
        const b = j * dims;
        // Four running sums: several times faster than one in V8 at 384 dimensions.
        let s0 = 0;
        let s1 = 0;
        let s2 = 0;
        let s3 = 0;
        let d = 0;
        for (; d + 3 < dims; d += 4) {
          s0 += packed[a + d]! * packed[b + d]!;
          s1 += packed[a + d + 1]! * packed[b + d + 1]!;
          s2 += packed[a + d + 2]! * packed[b + d + 2]!;
          s3 += packed[a + d + 3]! * packed[b + d + 3]!;
        }
        for (; d < dims; d += 1) s0 += packed[a + d]! * packed[b + d]!;
        const similarity = s0 + s1 + s2 + s3;
        if (similarity < minimum) continue;
        offer(i, j, similarity);
        offer(j, i, similarity);
      }
      await pause();
    }

    // k-NN edges, then the maximum spanning forest over the wider candidate set; the links the
    // clusters are found over (each node's nearest `CLUSTER_NEIGHBOURS`, weighted).
    const edges = new Map<number, { a: number; b: number; similarity: number; tree: boolean }>();
    const pairKey = (x: number, y: number) => (x < y ? x * n + y : y * n + x);
    const candidates = new Map<number, { a: number; b: number; similarity: number }>();
    const links = new Map<number, WeightedEdge>();
    for (let i = 0; i < n; i += 1) {
      for (let r = 0; r < topCount[i]!; r += 1) {
        const j = topIndex[i * keep + r]!;
        const pair = { a: Math.min(i, j), b: Math.max(i, j), similarity: topSim[i * keep + r]! };
        const key = pairKey(i, j);
        if (r < k && !edges.has(key)) edges.set(key, { ...pair, tree: false });
        if (!candidates.has(key)) candidates.set(key, pair);
        if (r < CLUSTER_NEIGHBOURS && !links.has(key)) links.set(key, { a: pair.a, b: pair.b, weight: clusterWeight(pair.similarity, minimum) });
      }
    }
    const forest = new UnionFind(n);
    const ordered = [...candidates.values()].sort((x, y) => y.similarity - x.similarity || x.a - y.a || x.b - y.b);
    for (const pair of ordered) {
      if (!forest.union(pair.a, pair.b)) continue;
      const key = pairKey(pair.a, pair.b);
      const existing = edges.get(key);
      if (existing) existing.tree = true;
      else edges.set(key, { ...pair, tree: true });
    }
    await pause();

    // Clusters: modularity communities over those links; largest first, then the newest member.
    const degree = new Int32Array(n);
    for (const edge of edges.values()) {
      degree[edge.a]! += 1;
      degree[edge.b]! += 1;
    }
    const community = await communities(n, [...links.values()], pause);
    const members = new Map<number, number[]>();
    for (let i = 0; i < n; i += 1) {
      let list = members.get(community[i]!);
      if (!list) members.set(community[i]!, (list = []));
      list.push(i);
    }
    const groups = [...members.values()].sort((x, y) => y.length - x.length || x[0]! - y[0]!);
    const cluster = new Int32Array(n);
    groups.forEach((group, id) => {
      for (const i of group) cluster[i] = id;
    });
    await pause();
    const labels = this.clusterLabels(groups, drawn);
    const clusters: KnowledgeSimilarityCluster[] = groups.map((group, id) => ({ id, size: group.length, label: labels[id]! }));

    return {
      ids: drawn.map((meta) => meta.id),
      cluster,
      degree,
      edges: [...edges.values()]
        .sort((x, y) => y.similarity - x.similarity || x.a - y.a || x.b - y.b)
        .map((edge) => ({ from: drawn[edge.a]!.id, to: drawn[edge.b]!.id, similarity: round(edge.similarity), tree: edge.tree })),
      clusters
    };
  }

  /**
   * A label per cluster (null for singletons, or when nothing names it), no two alike where that
   * can be helped:
   *
   * 1. Concepts, by name (one name can be several concepts, e.g. "App Store" as a Channel and a
   *    Platform), linked to at least two of the cluster's entries, never a Person, Organization or
   *    Company (who wrote or published an entry is not what it is about). Each scores coverage ×
   *    √precision — the share of the cluster linked to it times the root of the share of its drawn
   *    entries that are in the cluster — so a concept spread over the whole graph names no cluster
   *    it is merely common in, and a rare one on two entries does not beat one on most of them.
   *    Best scores are taken first across every cluster; a cluster whose best is taken gets its next.
   * 2. Else its most distinctive title words ({@link titleLabels}), the first not taken.
   * 3. Else a taken label (its best concept, then title words) rather than none.
   */
  private clusterLabels(groups: readonly (readonly number[])[], drawn: readonly KnowledgeEntryMeta[]): (string | null)[] {
    const named = drawn.map((meta) => {
      const names = new Map<string, string>();
      for (const concept of this.knowledgeGraph.conceptsOfEntry(meta.id)) {
        if (NON_TOPIC_CONCEPT_TYPES.has(concept.type.toLowerCase())) continue;
        const key = labelKey(concept.name);
        if (key && !names.has(key)) names.set(key, concept.name.replace(/\s+/g, " ").trim());
      }
      return names;
    });
    const df = new Map<string, number>();
    for (const names of named) for (const key of names.keys()) df.set(key, (df.get(key) ?? 0) + 1);

    const offers: { cluster: number; key: string; name: string; count: number; score: number }[] = [];
    for (const [cluster, group] of groups.entries()) {
      if (group.length < 2) continue;
      const inCluster = new Map<string, { count: number; spellings: Map<string, number> }>();
      for (const i of group) {
        for (const [key, name] of named[i]!) {
          let seen = inCluster.get(key);
          if (!seen) inCluster.set(key, (seen = { count: 0, spellings: new Map() }));
          seen.count += 1;
          seen.spellings.set(name, (seen.spellings.get(name) ?? 0) + 1);
        }
      }
      for (const [key, { count, spellings }] of inCluster) {
        if (count < 2) continue;
        // Named as its entries spell it most (first seen on a tie).
        const name = [...spellings].reduce((x, y) => (y[1] > x[1] ? y : x))[0];
        offers.push({ cluster, key, name, count, score: (count / group.length) * Math.sqrt(count / df.get(key)!) });
      }
    }
    offers.sort(
      (x, y) =>
        y.score - x.score || y.count - x.count || x.cluster - y.cluster || x.name.length - y.name.length || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0)
    );

    const labels: (string | null)[] = groups.map(() => null);
    const taken = new Set<string>();
    for (const offer of offers) {
      if (labels[offer.cluster] !== null || taken.has(offer.key)) continue;
      labels[offer.cluster] = offer.name;
      taken.add(offer.key);
    }
    let titles: TitleStats | null = null;
    for (const [cluster, group] of groups.entries()) {
      if (group.length < 2 || labels[cluster] !== null) continue;
      if (!titles) {
        const tokens = drawn.map((meta) => titleTokens(meta.title));
        const titleDf = new Map<string, number>();
        for (const words of tokens) for (const token of words.keys()) titleDf.set(token, (titleDf.get(token) ?? 0) + 1);
        titles = { tokens, df: titleDf };
      }
      const options = titleLabels(group, titles);
      const label =
        options.find((option) => !taken.has(labelKey(option))) ?? offers.find((offer) => offer.cluster === cluster)?.name ?? options[0] ?? null;
      labels[cluster] = label;
      if (label !== null) taken.add(labelKey(label));
    }
    return labels;
  }
}

/**
 * A cluster's title-word labels, best first: pairs of its three most distinctive title tokens
 * (numbers aside) — frequency in the cluster's titles over frequency in every drawn title, tokens
 * shared by at least two of its titles first (one title's word does not name a group) — then
 * single tokens. Each token is written as the word its titles use most for it (first seen on a tie).
 */
function titleLabels(group: readonly number[], { tokens, df }: TitleStats): string[] {
  const inCluster = new Map<string, { tf: number; words: Map<string, number> }>();
  for (const i of group) {
    for (const [token, word] of tokens[i]!) {
      if (/^\p{N}+$/u.test(token)) continue; // "día 1" and "7 días" are not about 1
      let seen = inCluster.get(token);
      if (!seen) inCluster.set(token, (seen = { tf: 0, words: new Map() }));
      seen.tf += 1;
      seen.words.set(word, (seen.words.get(word) ?? 0) + 1);
    }
  }
  const [first, second, third] = [...inCluster]
    .map(([token, { tf, words }]) => ({ token, tf, score: tf / (df.get(token) ?? tf), words }))
    .sort((a, b) => Number(b.tf >= 2) - Number(a.tf >= 2) || b.score - a.score || b.tf - a.tf || (a.token < b.token ? -1 : a.token > b.token ? 1 : 0))
    .slice(0, 3)
    .map(({ words }) => [...words].reduce((x, y) => (y[1] > x[1] ? y : x))[0]);
  if (first === undefined) return [];
  if (second === undefined) return [first];
  return third === undefined
    ? [`${first} ${second}`, first, second]
    : [`${first} ${second}`, `${first} ${third}`, `${second} ${third}`, first, second, third];
}
