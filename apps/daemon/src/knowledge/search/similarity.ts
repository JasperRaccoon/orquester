/**
 * Entry-to-entry similarity (retrieval spec docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md):
 *
 * - "Similar entries and possible duplicates (R5)" — {@link KnowledgeSimilarity.forEntry};
 * - "Near-duplicates on save (R6)" — {@link KnowledgeSimilarity.similarForSaved};
 * - "Similarity graph (R7)" — {@link KnowledgeSimilarity.graph}.
 *
 * Crossed with the concept graph (phase 2 spec docs/superpowers/specs/2026-10-27-knowledge-phase2-cross-graph-design.md,
 * "Cross-graph derivations"): distinctive shared concepts, contradictions, cluster concepts and novelty.
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
  type KnowledgeDisagreement,
  type KnowledgeEntryMeta,
  type KnowledgeEntrySummary,
  type KnowledgeNovelty,
  type KnowledgeRelatedReason,
  type KnowledgeSaveResult,
  type KnowledgeSimilarEntry,
  type KnowledgeSimilarityCluster,
  type KnowledgeSimilarityEdge,
  type KnowledgeSimilarityGraphResponse
} from "@orquester/api";
import type { KnowledgePairChecksPort, KnowledgeStorePort, KnowledgeVectorIndex, KnowledgeVectorThresholds } from "../ports.ts";
import { type WeightedEdge, communities } from "./communities.ts";
import { type KnowledgeContradictionFound, findContradictions, isSurveyEntry, pairKeyOf } from "./contradictions.ts";
import { normalizeAuthor } from "./filters.ts";
import type { KnowledgeClusterLabelsPort } from "./cluster-labels.ts";
import type { KnowledgeGraph } from "./graph.ts";
import { NEAR_COPY_MIN_RESEMBLANCE, resemblance, shingles } from "./near-copy.ts";
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
/** Latest graphs kept for novelty and saves, one per scope and model (more scopes than the graph cache: they are read without drawing). */
const LATEST_SIZE = 32;
/**
 * A scope whose latest graph was drawn in the background this recently is not drawn again in the
 * background (its latest may have been evicted by other scopes) unless the vectors or the concept
 * graph moved since: novelty and saves read null meanwhile.
 */
const BACKGROUND_REDRAW_MS = 5 * 60_000;
/** Background draws remembered for {@link BACKGROUND_REDRAW_MS} (the least recent go first). */
const BACKGROUND_DRAWS_MAX = 256;
/**
 * How the graph's clusters and labels are made; part of the cache key, so a daemon never serves a
 * graph drawn by an older rule. Bump it whenever clustering or labelling changes.
 */
const GRAPH_ALGORITHM = "communities-v3";
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
/**
 * A community of more than max(`CLUSTER_SPLIT_MIN`, `CLUSTER_SPLIT_SHARE` of the drawn entries) is
 * found again over its own links, and split when less than `CLUSTER_SPLIT_MAX_ACROSS` of its link
 * weight runs between the parts found. Surveys (a synthesis, a map or audit note:
 * {@link isSurveyEntry}) are left out of the links and join a cluster after: close to every topic
 * they survey, they glued the topics together. Without them modularity still merges the research
 * notes, which share a style, into one community (126 real entries: teardowns, Instagram, SEO
 * content and landing pages as one of 39 with its surveys): its resolution limit, which a pass over
 * the community alone does not have. Its parts share 35% of its link weight (teardowns 9, SEO
 * content 9, growth 9 and 5 more); the 34 App Store rule notes' parts share 49%, one topic kept
 * whole. A global resolution above 1 split both, and the small groups of a small base too.
 */
const CLUSTER_SPLIT_MIN = 12;
const CLUSTER_SPLIT_SHARE = 0.2;
const CLUSTER_SPLIT_MAX_ACROSS = 0.4;
/** Concept types that say who wrote or published entries, not what they are about: never a cluster label. */
export const NON_TOPIC_CONCEPT_TYPES: ReadonlySet<string> = new Set(["person", "organization", "company"]);
/** Concept types that make a claim (a single-source claim is one nobody else backs; novelty lists them first). */
export const CLAIM_CONCEPT_TYPES: ReadonlySet<string> = new Set(["tactic", "rule", "guideline", "result", "metric"]);
/**
 * A concept is distinctive when it is linked to at most max(`DISTINCTIVE_MIN_ENTRIES`,
 * `DISTINCTIVE_SHARE` of the visible entries) of them (phase 2 spec, "Hybrid similarity"): 126
 * entries → at most 3, 2,000 → at most 60. Two entries sharing one say more than two sharing "SEO".
 */
const DISTINCTIVE_SHARE = 0.03;
const DISTINCTIVE_MIN_ENTRIES = 2;
/**
 * Similar entries are ordered by meaning plus `DISTINCTIVE_BONUS` of the model's good→strong band
 * per distinctive shared concept, for at most `DISTINCTIVE_BONUS_CONCEPTS` of them. With e5
 * (good 0.83, strong 0.87) that is +0.01 a concept, +0.03 at most: it reorders entries whose
 * meaning is within 0.03, never lifts one past a neighbour a band closer, and meaning still
 * decides between any two entries further apart.
 */
const DISTINCTIVE_BONUS = 0.25;
const DISTINCTIVE_BONUS_CONCEPTS = 3;
/** Entries listed in `similar` because they contradict this one (even below the meaning bar). */
const CONTRADICTIONS_SIMILAR_MAX = 3;
/** Entries listed in an entry's `disagreements` (every one counted in `disagreementsTotal`). */
const DISAGREEMENTS_MAX = 20;
/** Concepts named per cluster (`KnowledgeSimilarityCluster.concepts`). */
const CLUSTER_CONCEPTS_MAX = 5;
/** Concepts named in an entry's `novelty`. */
const NOVELTY_CONCEPTS_MAX = 8;
/** Entries whose shingles ({@link shingles}) are kept for the near-copy check. */
const SHINGLES_CACHE_SIZE = 256;

/** The most entries a concept can be linked to and still be distinctive, among `visible` entries. */
export function distinctiveLimit(visible: number): number {
  return Math.max(DISTINCTIVE_MIN_ENTRIES, visible * DISTINCTIVE_SHARE);
}

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
/** A similarity cluster as entries name it (`KnowledgeNovelty.cluster`, `KnowledgeSaveResult.cluster`). */
export type KnowledgeClusterRef = { label: string | null; size: number };

export interface KnowledgeSimilarityOptions {
  store: Pick<KnowledgeStorePort, "listMeta" | "getMeta">;
  graph: Pick<KnowledgeGraph, "relatedEntries" | "conceptsOfEntry" | "conceptIdsOfEntry" | "revision" | "visibleEntriesOf" | "visibleEdgesOfType" | "conceptRef" | "backingConcepts">;
  /** The vector index, read per call; null while there is none. */
  index: () => KnowledgeVectorIndex | null;
  /** An entry as the read views show it (snippet, visible collections, link count, citation). */
  summary: (meta: KnowledgeEntryMeta, scope: KnowledgeScope) => KnowledgeEntrySummary;
  /** An entry's body as indexed (the near-copy check of duplicates); null when unknown. */
  body: (id: string) => string | null;
  /** Linking's LLM pair checks, read per call; absent or null: none. */
  pairChecks?: () => KnowledgePairChecksPort | null;
  /** Moves whenever the pair checks change (part of the graph's cache key); absent: never. */
  pairChecksRevision?: () => number;
  /** Milliseconds now (background draws are spaced by it); default `Date.now`. */
  now?: () => number;
}

interface Candidate {
  meta: KnowledgeEntryMeta;
  similarity: number | null;
  concepts: { refs: KnowledgeConceptRef[]; shared: number; distinctive: KnowledgeConceptRef[] } | null;
  author: string | null;
  contradiction: KnowledgeContradictionFound | null;
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
  /** Entry id → its index in `ids`. */
  position: Map<string, number>;
  cluster: Int32Array;
  degree: Int32Array;
  edges: KnowledgeSimilarityEdge[];
  clusters: KnowledgeSimilarityCluster[];
  /**
   * Per cluster: the entries an LLM label was named from (`clusters[i].label` is that label), or
   * null for a concept label. Checked again whenever the graph is served: a label never outlives
   * its visibility ({@link KnowledgeSimilarity.clusterLabel}).
   */
  labelSources: (readonly string[] | null)[];
  /** Per cluster: the concept label, shown instead of an LLM label one of whose sources is hidden. */
  conceptLabels: (string | null)[];
  /** Clusters drawn without an LLM label (member ids, most central first): asked for by the default unscoped draw. */
  unnamed: string[][];
}

export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += a[i]! * b[i]!;
  return sum;
}

export const round = (value: number): number => Math.round(value * 1e4) / 1e4;

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(Math.floor(value), max));
}

export function newestFirst(a: KnowledgeEntryMeta, b: KnowledgeEntryMeta): number {
  return b.savedAt.localeCompare(a.savedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** A stable key for what a scope lets through. */
export function scopeKey(scope: KnowledgeScope): string {
  const sorted = (set: ReadonlySet<string> | null) => (set ? [...set].sort() : null);
  return JSON.stringify([sorted(scope.canSee), sorted(scope.filter), scope.unfiled, [...scope.known].sort()]);
}

/** Whether a scope lets every entry through: `all` visibility, no narrowing. */
const unscoped = (scope: KnowledgeScope): boolean => scope.canSee === null && scope.filter === null && scope.unfiled;

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
export function yielder(): () => Promise<void> {
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
  private readonly body: KnowledgeSimilarityOptions["body"];
  /** Entry id → its shingles, keyed by a hash of the body they were made from; least recently used first. */
  private readonly shingleCache = new Map<string, { hash: string; shingles: Set<string> }>();
  /** Similarity graphs drawn in the background (novelty, a save's cluster), by scope and model. */
  private readonly drawing = new Map<string, Promise<void>>();
  private readonly pairChecks: () => KnowledgePairChecksPort | null;
  private readonly pairChecksRevision: () => number;
  /** Insertion order is least recently used first. */
  private readonly graphCache = new Map<string, { seq: number; structure: Promise<GraphStructure> }>();
  /**
   * The latest graph drawn per scope and model, whatever changed since (novelty and the save's
   * `cluster` read it without waiting for a new one); least recently used first.
   */
  private readonly latest = new Map<string, { seq: number; structure: GraphStructure }>();
  /** Background draws by scope and model: when, and at which vectors and concept graph; least recent first. */
  private readonly backgroundDraws = new Map<string, { at: number; generation: number; revision: number }>();
  private readonly now: () => number;
  private seq = 0;
  /** LLM topic names for clusters ({@link connectClusterLabels}); null: the concept labels only. */
  private clusterNames: KnowledgeClusterLabelsPort | null = null;

  constructor(options: KnowledgeSimilarityOptions) {
    this.store = options.store;
    this.knowledgeGraph = options.graph;
    this.index = options.index;
    this.summary = options.summary;
    this.body = options.body;
    this.pairChecks = options.pairChecks ?? (() => null);
    this.pairChecksRevision = options.pairChecksRevision ?? (() => 0);
    this.now = options.now ?? Date.now;
  }

  /** Moves whenever an LLM cluster name is added (part of every cache over the graph's labels); null when none are connected. */
  clusterLabelsRevision(): number | null {
    return this.clusterNames?.revision() ?? null;
  }

  /**
   * Clusters of 3+ entries take the LLM's topic name from `port` when it has one and the caller sees
   * every entry it was named from (else their concept label, as without it); the unscoped default
   * draw asks it for the ones it lacks (`cluster-labels.ts`). Null disconnects.
   */
  connectClusterLabels(port: KnowledgeClusterLabelsPort | null): void {
    this.clusterNames = port;
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
   * meaning (cosine ≥ `good`, up to 8), the entries sharing concepts with it, the 2 most recent
   * by the same author or handle, and up to 3 entries that contradict it ({@link findContradictions},
   * always kept among the 8, even below `good`); each with every reason that applies; ordered by
   * similarity plus the distinctive-concept bonus ({@link DISTINCTIVE_BONUS}; none last), shared
   * concepts, then newest; at most 8. A candidate sharing a visible concept with it has the
   * `concepts` reason whichever way it was found. Duplicates: up to 3 at cosine ≥ `duplicate` whose
   * text is a near-copy of its own ({@link nearCopy}). Only entries `scope` lets through; never the
   * entry itself.
   *
   * `disagreements`: every entry that contradicts it, in the same order (checked first, then the
   * closest), up to {@link DISAGREEMENTS_MAX}, whatever the `similar` cap; `disagreementsTotal`
   * counts them all. {@link findContradictions} is symmetric, so B is on A's list whenever A is on B's.
   */
  forEntry(
    id: string,
    scope: KnowledgeScope
  ): { similar: KnowledgeSimilarEntry[]; possibleDuplicates: KnowledgeSimilarEntry[]; disagreements: KnowledgeDisagreement[]; disagreementsTotal: number } {
    const meta = this.store.getMeta(id);
    if (!meta) return { similar: [], possibleDuplicates: [], disagreements: [], disagreementsTotal: 0 };
    const vectors = this.vectors();
    const own = vectors ? vectors.index.entryVector(id) : null;
    const candidates = new Map<string, Candidate>();
    const candidate = (other: KnowledgeEntryMeta): Candidate => {
      let found = candidates.get(other.id);
      if (!found) candidates.set(other.id, (found = { meta: other, similarity: null, concepts: null, author: null, contradiction: null }));
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

    // (b) Shared concepts, and the distinctive ones among them.
    const ownConcepts = this.knowledgeGraph.conceptsOfEntry(id, scope);
    const related = this.knowledgeGraph.relatedEntries(id, scope, KNOWLEDGE_SIMILAR_MAX);
    const distinctive = ownConcepts.length > 0 ? this.distinctiveTest(scope) : () => false;
    for (const { id: otherId } of related) {
      if (otherId === id) continue;
      const otherMeta = this.visibleMeta(otherId, scope);
      if (otherMeta) candidate(otherMeta);
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

    // (d) Entries that contradict it: checked ones first, then the closest.
    const contradicting = [
      ...findContradictions({
        graph: this.knowledgeGraph,
        scope,
        pairChecks: this.pairChecks(),
        accept: (other) => (other === id ? entryInScope(meta, scope) : this.visibleMeta(other, scope) !== null),
        entryId: id,
        entryMeta: (other) => this.store.getMeta(other)
      }).values()
    ];
    const disagreeing = contradicting
      .map((found) => {
        const otherMeta = this.store.getMeta(found.a === id ? found.b : found.a)!;
        const similarity = vectors && own ? (this.cosine(vectors.index, own, otherMeta.id) ?? -Infinity) : -Infinity;
        return { found, meta: otherMeta, similarity, checked: Number(found.source === "checked") };
      })
      .sort((x, y) => y.checked - x.checked || y.similarity - x.similarity || newestFirst(x.meta, y.meta));
    for (const item of disagreeing.slice(0, CONTRADICTIONS_SIMILAR_MAX)) candidate(item.meta).contradiction = item.found;

    // The concepts every candidate shares with it, however it was found (the distinctive ones named first).
    if (ownConcepts.length > 0) {
      for (const found of candidates.values()) {
        const theirs = new Set(this.knowledgeGraph.conceptsOfEntry(found.meta.id, scope).map((c) => c.id));
        const common = ownConcepts.filter((c) => theirs.has(c.id));
        if (common.length === 0) continue;
        const telling = common.filter((c) => distinctive(c.id));
        const named = [...telling, ...common.filter((c) => !telling.includes(c))];
        found.concepts = { refs: named.slice(0, SHARED_CONCEPTS_NAMED), shared: common.length, distinctive: telling };
      }
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
      if (found.contradiction) {
        const { source, pairs, note } = found.contradiction;
        reasons.push({ kind: "contradicts", source, pairs: pairs.map((pair) => ({ from: { ...pair.from }, to: { ...pair.to } })), note });
      }
      if (vectors && found.similarity !== null && found.similarity >= vectors.thresholds.good) {
        reasons.push({ kind: "meaning", similarity: round(found.similarity) });
      }
      if (found.concepts) {
        const { refs, shared, distinctive: telling } = found.concepts;
        reasons.push({
          kind: "concepts",
          concepts: refs.map((c) => ({ ...c })),
          shared,
          ...(telling.length > 0 ? { distinctive: telling.slice(0, SHARED_CONCEPTS_NAMED).map((c) => ({ ...c })) } : {})
        });
      }
      if (found.author !== null) reasons.push({ kind: "author", value: found.author });
      return { entry: this.summary(found.meta, scope), similarity: found.similarity === null ? null : round(found.similarity), reasons };
    };

    // Meaning first; each distinctive shared concept adds a bonus too small to outweigh it.
    const bonus = vectors ? DISTINCTIVE_BONUS * Math.max(0, vectors.thresholds.strong - vectors.thresholds.good) : 0;
    const rank = (found: Candidate): number =>
      found.similarity === null ? -Infinity : found.similarity + bonus * Math.min(found.concepts?.distinctive.length ?? 0, DISTINCTIVE_BONUS_CONCEPTS);
    const ordered = [...candidates.values()].sort(
      (a, b) => rank(b) - rank(a) || (b.concepts?.shared ?? 0) - (a.concepts?.shared ?? 0) || newestFirst(a.meta, b.meta)
    );
    // Contradicting entries keep their place among the 8; the rest fill it in order.
    let room = KNOWLEDGE_SIMILAR_MAX - ordered.filter((found) => found.contradiction !== null).length;
    const listed = ordered.filter((found) => found.contradiction !== null || room-- > 0);
    const duplicate = vectors?.thresholds.duplicate ?? Infinity;
    return {
      similar: listed.map(toWire),
      possibleDuplicates: neighbours
        .filter((n) => n.similarity >= duplicate && this.nearCopy(id, n.meta.id))
        .slice(0, KNOWLEDGE_DUPLICATES_MAX)
        .map((n) => toWire(candidates.get(n.meta.id)!)),
      disagreements: disagreeing.slice(0, DISAGREEMENTS_MAX).map(({ found, meta: other, similarity }) => ({
        entry: this.summary(other, scope),
        similarity: Number.isFinite(similarity) ? round(similarity) : null,
        source: found.source,
        pairs: found.pairs.map((pair) => ({ from: { ...pair.from }, to: { ...pair.to } })),
        note: found.note
      })),
      disagreementsTotal: disagreeing.length
    };
  }

  /** Whether two entries' texts are near-copies ({@link NEAR_COPY_MIN_RESEMBLANCE}); never when either body is unknown. */
  private nearCopy(a: string, b: string): boolean {
    const x = this.shinglesOf(a);
    const y = x ? this.shinglesOf(b) : null;
    return x !== null && y !== null && resemblance(x, y) >= NEAR_COPY_MIN_RESEMBLANCE;
  }

  private shinglesOf(id: string): Set<string> | null {
    // Keyed by the body actually read, not the entry's content hash: the two can disagree for a
    // moment (an edit lands in one before the other), and shingles must match the text compared.
    const body = this.store.getMeta(id) ? this.body(id) : null;
    if (body === null) return null;
    const hash = createHash("sha1").update(body, "utf8").digest("base64");
    const cached = this.shingleCache.get(id);
    if (cached && cached.hash === hash) {
      this.shingleCache.delete(id); // most recently used last
      this.shingleCache.set(id, cached);
      return cached.shingles;
    }
    const made = { hash, shingles: shingles(body) };
    this.shingleCache.delete(id);
    this.shingleCache.set(id, made);
    while (this.shingleCache.size > SHINGLES_CACHE_SIZE) this.shingleCache.delete(this.shingleCache.keys().next().value!);
    return made.shingles;
  }

  private cosine(index: KnowledgeVectorIndex, own: Float32Array, other: string): number | null {
    const vector = index.entryVector(other);
    return vector ? dot(own, vector) : null;
  }

  /** Whether a concept is distinctive among the entries `scope` lets through ({@link distinctiveLimit}); memoized per call. */
  private distinctiveTest(scope: KnowledgeScope): (conceptId: string) => boolean {
    let visible = 0;
    for (const meta of this.store.listMeta()) if (entryInScope(meta, scope)) visible += 1;
    const limit = distinctiveLimit(visible);
    const counts = new Map<string, number>();
    return (conceptId) => {
      let count = counts.get(conceptId);
      if (count === undefined) counts.set(conceptId, (count = this.knowledgeGraph.visibleEntriesOf(conceptId, scope).length));
      return count <= limit;
    };
  }

  // -------------------------------------------------------------------------
  // Novelty (phase 2 spec, "Novelty")
  // -------------------------------------------------------------------------

  /**
   * What the entry adds: its concepts no other visible entry has, in these words or in others (`backingConcepts`; claims first, people and
   * organizations last, up to 8), and the cluster it sits in by the latest similarity graph drawn
   * for `scope` (any `k` and `limit`: the layer's, insights'). Null when none is drawn yet: it never
   * waits for one, it starts drawing one in the background for the next read. Null while the entry
   * has no vectors.
   */
  novelty(id: string, scope: KnowledgeScope): KnowledgeNovelty | null {
    const vectors = this.vectors();
    const own = vectors?.index.entryVector(id) ?? null;
    if (!vectors || !own) return null;
    const rankOf = (type: string): number => {
      const key = type.toLowerCase();
      return CLAIM_CONCEPT_TYPES.has(key) ? 0 : NON_TOPIC_CONCEPT_TYPES.has(key) ? 2 : 1;
    };
    const onlyHere = (conceptId: string): boolean => this.knowledgeGraph.visibleEntriesOf(conceptId, scope).every((other) => other === id);
    const newConcepts = this.knowledgeGraph
      .conceptsOfEntry(id, scope)
      // Nor said in other words by another entry (a concept that backs it).
      .filter((concept) => onlyHere(concept.id) && this.knowledgeGraph.backingConcepts(concept.id).every(onlyHere))
      .map((concept, order) => ({ concept, order, rank: rankOf(concept.type) }))
      .sort((a, b) => a.rank - b.rank || a.order - b.order)
      .slice(0, NOVELTY_CONCEPTS_MAX)
      .map(({ concept }) => ({ ...concept }));
    const structure = this.latestStructure(scope, vectors.index);
    if (!structure) this.drawInBackground(scope, vectors.index);
    return { newConcepts, cluster: structure ? this.clusterRef(structure, clusterOf(structure, id, own, vectors.index, vectors.thresholds.minimum, new Set()), scope) : null };
  }

  /**
   * The cluster each of `entryIds` (entries one save just created) joins, by its nearest drawn
   * neighbours in the latest similarity graph for `scope` (entries of the same save aside); null
   * when it has no vectors yet, no graph was drawn yet (one is then drawn in the background), or its
   * neighbours are a singleton or none. Never waits: it reads what is already drawn.
   */
  clustersForSaved(entryIds: readonly string[], scope: KnowledgeScope): Map<string, KnowledgeClusterRef | null> {
    const out = new Map<string, KnowledgeClusterRef | null>(entryIds.map((id) => [id, null]));
    const vectors = this.vectors();
    if (!vectors || entryIds.length === 0) return out;
    const structure = this.latestStructure(scope, vectors.index);
    if (!structure) {
      this.drawInBackground(scope, vectors.index);
      return out;
    }
    const exclude = new Set(entryIds);
    for (const id of entryIds) {
      const own = vectors.index.entryVector(id);
      if (own) out.set(id, this.clusterRef(structure, clusterOf(structure, id, own, vectors.index, vectors.thresholds.minimum, exclude), scope));
    }
    return out;
  }

  /**
   * The latest graph drawn for `scope` with the current model, while every drawn entry that still
   * exists is still in scope (otherwise its labels could name what the caller no longer sees).
   */
  private latestStructure(scope: KnowledgeScope, index: KnowledgeVectorIndex): GraphStructure | null {
    const key = JSON.stringify([scopeKey(scope), index.modelId()]);
    const found = this.latest.get(key);
    if (!found) return null;
    for (const id of found.structure.ids) {
      const meta = this.store.getMeta(id);
      if (meta && !entryInScope(meta, scope)) {
        // Stale, not evicted: a new one may be drawn in the background at once.
        this.backgroundDraws.delete(key);
        return null;
      }
    }
    return found.structure;
  }

  /**
   * Draw the default similarity graph for `scope` after the current turn of the event loop (so the
   * read that asked returns first), once at a time per scope and model; what it draws becomes the
   * latest graph novelty and saves read.
   */
  private drawInBackground(scope: KnowledgeScope, index: KnowledgeVectorIndex): void {
    const key = JSON.stringify([scopeKey(scope), index.modelId()]);
    if (this.drawing.has(key)) return;
    // Bounded: a scope drawn lately is not drawn again (its latest graph may have made room for
    // other scopes') until the vectors or the concept graph move, or a while has passed.
    const at = this.now();
    const generation = index.generation();
    const revision = this.knowledgeGraph.revision();
    const last = this.backgroundDraws.get(key);
    if (last && at - last.at < BACKGROUND_REDRAW_MS && last.generation === generation && last.revision === revision) return;
    this.backgroundDraws.delete(key);
    this.backgroundDraws.set(key, { at, generation, revision });
    while (this.backgroundDraws.size > BACKGROUND_DRAWS_MAX) this.backgroundDraws.delete(this.backgroundDraws.keys().next().value!);
    const drawn = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.graph({}, scope))
      .then(
        () => undefined,
        () => undefined
      )
      .finally(() => this.drawing.delete(key));
    this.drawing.set(key, drawn);
  }

  /** Resolves once the similarity graphs drawn in the background have been drawn (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.drawing.size > 0) await Promise.all([...this.drawing.values()]);
  }

  private remember(scope: KnowledgeScope, index: KnowledgeVectorIndex, seq: number, structure: GraphStructure): void {
    const key = JSON.stringify([scopeKey(scope), index.modelId()]);
    const previous = this.latest.get(key);
    if (previous && previous.seq > seq) return;
    this.latest.delete(key);
    this.latest.set(key, { seq, structure });
    while (this.latest.size > LATEST_SIZE) this.latest.delete(this.latest.keys().next().value!);
  }

  // -------------------------------------------------------------------------
  // R6: near-duplicates on save
  // -------------------------------------------------------------------------

  /**
   * For each of `entryIds` (entries one save just created) that has vectors: up to 3 entries
   * `scope` lets through, not among `entryIds`, at cosine ≥ the model's `duplicate` threshold whose
   * text is a near-copy of its own ({@link nearCopy}), closest first. Entries without vectors (not
   * embedded within the save's wait) get `[]`.
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
        if (similarity >= vectors.thresholds.duplicate && this.nearCopy(id, other.meta.id)) close.push({ meta: other.meta, similarity });
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
   * modularity communities ({@link communities}) over each non-survey node's top-4 non-survey
   * neighbours weighted by {@link clusterWeight}, an oversize one found again over its own links
   * ({@link CLUSTER_SPLIT_MIN}), each survey then joining the one its top-4 weigh most in; largest
   * first, labelled and given their concepts by {@link clusterLabels}.
   * Every edge carries the concepts its two entries share; two drawn entries that contradict each
   * other ({@link findContradictions}) are joined by an edge marked `contradicts` (added, not part
   * of the forest, when they were not neighbours). Cached per algorithm, scope, k, index
   * generation, graph revision, pair checks and drawn entries (which `limit` decides); yields to the
   * event loop while it computes.
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
      vectors.index.modelId(),
      vectors.thresholds,
      vectors.index.generation(),
      this.knowledgeGraph.revision(),
      this.pairChecksRevision(),
      this.clusterNames?.revision() ?? null,
      fingerprint.digest("base64")
    ]);

    let cached = this.graphCache.get(key);
    if (cached) {
      this.graphCache.delete(key); // most recently used last
      this.graphCache.set(key, cached);
    } else {
      const entry = (cached = { seq: ++this.seq, structure: this.computeGraph(kept, k, vectors.index, vectors.thresholds, scope) });
      this.graphCache.set(key, entry);
      while (this.graphCache.size > GRAPH_CACHE_SIZE) this.graphCache.delete(this.graphCache.keys().next().value!);
      entry.structure.catch(() => {
        if (this.graphCache.get(key) === entry) this.graphCache.delete(key);
      });
    }
    const built = await cached.structure;
    this.remember(scope, vectors.index, cached.seq, built);
    // Names are asked for from the unscoped default draw only (the one linking's rounds refresh):
    // a scoped draw, or another `k` or `limit`, cuts the clusters differently.
    const names = this.clusterNames;
    if (names && built.unnamed.length > 0 && unscoped(scope) && k === KNOWLEDGE_SIMILARITY_GRAPH_DEFAULT_K && limit === KNOWLEDGE_SIMILARITY_GRAPH_DEFAULT_NODES) {
      names.request(built.unnamed);
    }

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
      clusters: built.clusters.map((cluster, i) => {
        const label = this.clusterLabel(built, i, scope);
        return cluster.concepts ? { ...cluster, label, concepts: cluster.concepts.map((c) => ({ ...c })) } : { ...cluster, label };
      }),
      truncated: embedded.length > limit,
      totals: { entries: visible.length, embedded: embedded.length }
    };
  }

  private async computeGraph(
    kept: readonly KnowledgeEntryMeta[],
    k: number,
    index: KnowledgeVectorIndex,
    thresholds: KnowledgeVectorThresholds,
    scope: KnowledgeScope
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

    // Each node's best `keep` neighbours at or above `minimum`, best first (earlier offers win ties);
    // and, for the clusters, its best `CLUSTER_NEIGHBOURS` among the entries that are not surveys.
    const keep = Math.max(k, TREE_CANDIDATES);
    const best = (size: number) => {
      const index = new Int32Array(n * size).fill(-1);
      const sim = new Float64Array(n * size);
      const count = new Int32Array(n);
      const offer = (node: number, other: number, similarity: number): void => {
        const base = node * size;
        let at = count[node]!;
        if (at < size) count[node] = at + 1;
        else if (similarity > sim[base + size - 1]!) at = size - 1;
        else return;
        while (at > 0 && sim[base + at - 1]! < similarity) {
          sim[base + at] = sim[base + at - 1]!;
          index[base + at] = index[base + at - 1]!;
          at -= 1;
        }
        sim[base + at] = similarity;
        index[base + at] = other;
      };
      return { index, sim, count, offer };
    };
    const { index: topIndex, sim: topSim, count: topCount, offer } = best(keep);
    const near = best(CLUSTER_NEIGHBOURS);
    // A survey (a synthesis, a map or audit note) is close to every topic it surveys: as a link it
    // would glue them into one cluster. Clusters are found without them, then each joins its own.
    const survey = drawn.map((meta) => isSurveyEntry(meta));
    if (survey.every(Boolean)) survey.fill(false);
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
        if (!survey[j]) near.offer(i, j, similarity);
        if (!survey[i]) near.offer(j, i, similarity);
      }
      await pause();
    }

    // k-NN edges, then the maximum spanning forest over the wider candidate set; the links the
    // clusters are found over (each non-survey node's nearest `CLUSTER_NEIGHBOURS` non-survey ones, weighted).
    const edges = new Map<number, { a: number; b: number; similarity: number; tree: boolean; contradicts?: true }>();
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
      }
      if (survey[i]) continue;
      for (let r = 0; r < near.count[i]!; r += 1) {
        const j = near.index[i * CLUSTER_NEIGHBOURS + r]!;
        const key = pairKey(i, j);
        if (!links.has(key)) links.set(key, { a: Math.min(i, j), b: Math.max(i, j), weight: clusterWeight(near.sim[i * CLUSTER_NEIGHBOURS + r]!, minimum) });
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

    // Contradicting entries: their edge marked, or added when they were not neighbours.
    const position = new Map(drawn.map((meta, i) => [meta.id, i]));
    const contradictions = findContradictions({
      graph: this.knowledgeGraph,
      scope,
      pairChecks: this.pairChecks(),
      accept: (id) => position.has(id),
      entryMeta: (id) => this.store.getMeta(id)
    });
    for (const { a: from, b: to } of contradictions.values()) {
      const [x, y] = [position.get(from)!, position.get(to)!];
      const key = pairKey(x, y);
      const existing = edges.get(key);
      if (existing) existing.contradicts = true;
      else {
        let similarity = 0;
        for (let d = 0; d < dims; d += 1) similarity += packed[x * dims + d]! * packed[y * dims + d]!;
        edges.set(key, { a: Math.min(x, y), b: Math.max(x, y), similarity, tree: false, contradicts: true });
      }
    }
    // Concepts each drawn entry links to (every one visible: the entry is).
    const concepts = drawn.map((meta) => this.knowledgeGraph.conceptsOfEntry(meta.id, scope));
    const conceptSets = concepts.map((list) => new Set(list.map((concept) => concept.id)));
    const sharedConcepts = (x: number, y: number): number => {
      const [small, large] = conceptSets[x]!.size <= conceptSets[y]!.size ? [conceptSets[x]!, conceptSets[y]!] : [conceptSets[y]!, conceptSets[x]!];
      let shared = 0;
      for (const id of small) if (large.has(id)) shared += 1;
      return shared;
    };
    await pause();

    // Clusters: modularity communities over those links; largest first, then the newest member.
    const degree = new Int32Array(n);
    for (const edge of edges.values()) {
      degree[edge.a]! += 1;
      degree[edge.b]! += 1;
    }
    const community = await communities(n, [...links.values()], pause);
    // A community holding a large share of the entries is found again over its own links: on the
    // whole graph modularity cannot tell its topics apart (its resolution limit).
    const oversize = Math.max(CLUSTER_SPLIT_MIN, CLUSTER_SPLIT_SHARE * n);
    const sizes = new Map<number, number[]>();
    for (let i = 0; i < n; i += 1) {
      let list = sizes.get(community[i]!);
      if (!list) sizes.set(community[i]!, (list = []));
      list.push(i);
    }
    let fresh = n;
    for (const group of sizes.values()) {
      if (group.length <= oversize) continue;
      const local = new Map(group.map((node, at) => [node, at]));
      const inner: WeightedEdge[] = [];
      for (const link of links.values()) {
        const a = local.get(link.a);
        const b = local.get(link.b);
        if (a !== undefined && b !== undefined) inner.push({ a, b, weight: link.weight });
      }
      const parts = await communities(group.length, inner, pause);
      // Kept whole when its parts are still bound by much of its link weight: one topic, not several.
      let across = 0;
      let within = 0;
      for (const link of inner) {
        if (parts[link.a] === parts[link.b]) within += link.weight;
        else across += link.weight;
      }
      if (across >= CLUSTER_SPLIT_MAX_ACROSS * (across + within)) continue;
      group.forEach((node, at) => {
        community[node] = fresh + parts[at]!;
      });
      fresh += group.length;
    }
    // Each survey joins the community its nearest non-survey entries weigh most in (the nearest's on a tie).
    for (let i = 0; i < n; i += 1) {
      if (!survey[i] || near.count[i] === 0) continue;
      const weight = new Map<number, number>();
      for (let r = 0; r < near.count[i]!; r += 1) {
        const c = community[near.index[i * CLUSTER_NEIGHBOURS + r]!]!;
        weight.set(c, (weight.get(c) ?? 0) + clusterWeight(near.sim[i * CLUSTER_NEIGHBOURS + r]!, minimum));
      }
      let chosen = community[i]!;
      let most = 0;
      for (const [c, total] of weight) {
        if (total > most) {
          chosen = c;
          most = total;
        }
      }
      community[i] = chosen;
    }
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
    const named = clusterLabels(groups, drawn, concepts);
    // LLM topic names where there are some (`connectClusterLabels`), with the entries they were named
    // from; the rest are asked for by `graph` (the unscoped default draw only).
    const names = this.clusterNames;
    const membersOf = (group: readonly number[]): string[] => [...group].sort((x, y) => degree[y]! - degree[x]! || x - y).map((i) => drawn[i]!.id);
    const hidden = (entryId: string): boolean => {
      const meta = this.store.getMeta(entryId);
      return meta !== null && meta !== undefined && !entryInScope(meta, scope);
    };
    const unnamed: string[][] = [];
    const labelSources: (readonly string[] | null)[] = groups.map(() => null);
    const clusters: KnowledgeSimilarityCluster[] = groups.map((group, id) => {
      const { concepts: top } = named[id]!;
      let label = named[id]!.label;
      if (names) {
        const members = membersOf(group);
        const topic = names.labelFor(members, hidden);
        if (topic !== null) {
          label = topic.label;
          labelSources[id] = topic.sources;
        } else unnamed.push(members);
      }
      return top.length > 0 ? { id, size: group.length, label, concepts: top } : { id, size: group.length, label };
    });

    return {
      ids: drawn.map((meta) => meta.id),
      position,
      cluster,
      degree,
      edges: [...edges.values()]
        .sort((x, y) => y.similarity - x.similarity || x.a - y.a || x.b - y.b)
        .map((edge) => {
          const shared = sharedConcepts(edge.a, edge.b);
          return {
            from: drawn[edge.a]!.id,
            to: drawn[edge.b]!.id,
            similarity: round(edge.similarity),
            tree: edge.tree,
            ...(shared > 0 ? { sharedConcepts: shared } : {}),
            ...(edge.contradicts ? { contradicts: true } : {})
          };
        }),
      clusters,
      labelSources,
      conceptLabels: named.map((item) => item.label),
      unnamed
    };
  }

  /**
   * A drawn cluster's label as `scope` may see it: an LLM label only while every entry it was named
   * from is still visible (an entry may have moved out of view since the graph was drawn), else the
   * concept label.
   */
  private clusterLabel(structure: GraphStructure, cluster: number, scope: KnowledgeScope): string | null {
    const label = structure.clusters[cluster]!.label;
    const sources = structure.labelSources[cluster];
    if (!sources) return label;
    for (const id of sources) {
      const meta = this.store.getMeta(id);
      if (meta && !entryInScope(meta, scope)) return structure.conceptLabels[cluster] ?? null;
    }
    return label;
  }

  /** A cluster as entries name it ({@link clusterOf}'s), labelled as `scope` may see it; null for a singleton or none. */
  private clusterRef(structure: GraphStructure, cluster: number, scope: KnowledgeScope): KnowledgeClusterRef | null {
    const found = cluster >= 0 ? structure.clusters[cluster] : undefined;
    return found && found.size >= 2 ? { label: this.clusterLabel(structure, cluster, scope), size: found.size } : null;
  }

}

/**
 * A label and up to {@link CLUSTER_CONCEPTS_MAX} concepts per cluster (null and none for
 * singletons, or when nothing names it); no two labels alike where that can be helped:
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
 *
 * A cluster's `concepts` are those same concept names, best score first — the one its label names
 * leading — each as the concept of that name most of the cluster's entries link to.
 */
function clusterLabels(
  groups: readonly (readonly number[])[],
  drawn: readonly KnowledgeEntryMeta[],
  conceptsOf: readonly (readonly KnowledgeConceptRef[])[]
): { label: string | null; concepts: KnowledgeConceptRef[] }[] {
  const named = conceptsOf.map((list) => {
    const names = new Map<string, { name: string; refs: KnowledgeConceptRef[] }>();
    for (const concept of list) {
      if (NON_TOPIC_CONCEPT_TYPES.has(concept.type.toLowerCase())) continue;
      const key = labelKey(concept.name);
      if (!key) continue;
      const seen = names.get(key);
      if (seen) seen.refs.push(concept);
      else names.set(key, { name: concept.name.replace(/\s+/g, " ").trim(), refs: [concept] });
    }
    return names;
  });
  const df = new Map<string, number>();
  for (const names of named) for (const key of names.keys()) df.set(key, (df.get(key) ?? 0) + 1);

  const offers: { cluster: number; key: string; name: string; concept: KnowledgeConceptRef; count: number; score: number }[] = [];
  for (const [cluster, group] of groups.entries()) {
    if (group.length < 2) continue;
    const inCluster = new Map<string, { count: number; spellings: Map<string, number>; concepts: Map<string, { ref: KnowledgeConceptRef; count: number }> }>();
    for (const i of group) {
      for (const [key, { name, refs }] of named[i]!) {
        let seen = inCluster.get(key);
        if (!seen) inCluster.set(key, (seen = { count: 0, spellings: new Map(), concepts: new Map() }));
        seen.count += 1;
        seen.spellings.set(name, (seen.spellings.get(name) ?? 0) + 1);
        for (const ref of refs) {
          const counted = seen.concepts.get(ref.id);
          if (counted) counted.count += 1;
          else seen.concepts.set(ref.id, { ref, count: 1 });
        }
      }
    }
    for (const [key, { count, spellings, concepts }] of inCluster) {
      if (count < 2) continue;
      // Named as its entries spell it most, and as the concept most of them link to (first seen on a tie).
      const name = [...spellings].reduce((x, y) => (y[1] > x[1] ? y : x))[0];
      const concept = [...concepts.values()].reduce((x, y) => (y.count > x.count ? y : x)).ref;
      offers.push({ cluster, key, name, concept, count, score: (count / group.length) * Math.sqrt(count / df.get(key)!) });
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

  const concepts: KnowledgeConceptRef[][] = groups.map(() => []);
  for (const offer of offers) concepts[offer.cluster]!.push(offer.concept);
  return labels.map((label, cluster) => {
    const list = concepts[cluster]!;
    const key = label === null ? null : labelKey(label);
    const lead = key === null ? -1 : list.findIndex((concept) => labelKey(concept.name) === key);
    const ordered = lead > 0 ? [list[lead]!, ...list.slice(0, lead), ...list.slice(lead + 1)] : list;
    return { label, concepts: ordered.slice(0, CLUSTER_CONCEPTS_MAX).map((concept) => ({ id: concept.id, name: concept.name, type: concept.type })) };
  });
}

/**
 * The entry's cluster in `structure` (its index; -1 for none): its own when drawn, else the one
 * most of its nearest drawn neighbours (cosine ≥ `minimum`, up to {@link CLUSTER_NEIGHBOURS},
 * `exclude` aside) are in, the nearest's on a tie.
 */
function clusterOf(
  structure: GraphStructure,
  id: string,
  own: Float32Array,
  index: KnowledgeVectorIndex,
  minimum: number,
  exclude: ReadonlySet<string>
): number {
  let cluster = structure.position.get(id) ?? -1;
  if (cluster >= 0) cluster = structure.cluster[cluster]!;
  else {
    const near: { cluster: number; similarity: number }[] = [];
    structure.ids.forEach((other, i) => {
      if (exclude.has(other) || other === id) return;
      const vector = index.entryVector(other);
      const similarity = vector ? dot(own, vector) : -Infinity;
      if (similarity >= minimum) near.push({ cluster: structure.cluster[i]!, similarity });
    });
    near.sort((a, b) => b.similarity - a.similarity);
    // Map order is the order the neighbours were met in, nearest first: a tie keeps the nearest's.
    const votes = new Map<number, number>();
    for (const { cluster: c } of near.slice(0, CLUSTER_NEIGHBOURS)) votes.set(c, (votes.get(c) ?? 0) + 1);
    let best = 0;
    for (const [c, count] of votes) {
      if (count > best) {
        cluster = c;
        best = count;
      }
    }
  }
  return cluster;
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
