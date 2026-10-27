/**
 * Insights (phase 2 spec docs/superpowers/specs/2026-10-27-knowledge-phase2-cross-graph-design.md,
 * "Cross-graph derivations and insights"): what crossing the concept graph with the similarity
 * graph shows that neither shows alone, over the entries a scope lets through.
 *
 * - Contradictions: {@link findContradictions} over every visible pair; checked ones first, then
 *   the closest in meaning.
 * - Bridges: entries whose distinctive concepts ({@link distinctiveLimit}; never a person or an
 *   organization) are shared with entries in at least 2 other clusters of two or more; most
 *   clusters first, then most such concepts, then newest.
 * - Single-source concepts: claims (Tactic, Rule, Guideline, Result, Metric) linked to exactly one
 *   visible entry that sits in a cluster of 3 or more; taken one per entry in turn (entries in
 *   larger clusters first, then newest), so one prolific entry does not fill the list.
 * - Link gaps: {@link findLinkGaps} at the model's `strong` threshold; `queued` from the re-linker.
 *
 * Clusters are those of the similarity graph over the most recent
 * {@link KNOWLEDGE_SIMILARITY_GRAPH_MAX_NODES} embedded entries (the default `k`; the same clusters
 * and labels as the Similarity layer while the base is under its default node count). Every list is
 * counted before `limit`. Cached per scope, limit, model, index generation, graph revision, pair
 * checks and the visible entries; link gaps (the costly part, independent of pair checks and
 * `limit`) are cached on their own. Yields to the event loop while it computes.
 */

import { createHash } from "node:crypto";
import {
  KNOWLEDGE_SIMILARITY_GRAPH_MAX_NODES,
  type KnowledgeBridge,
  type KnowledgeConceptRef,
  type KnowledgeContradiction,
  type KnowledgeEntryMeta,
  type KnowledgeEntrySummary,
  type KnowledgeInsightsResponse,
  type KnowledgeLinkGap,
  type KnowledgeSimilarityGraphResponse,
  type KnowledgeSingleSource
} from "@orquester/api";
import type { KnowledgePairChecksPort, KnowledgeStorePort, KnowledgeVectorIndex } from "../ports.ts";
import { findContradictions, type ContradictionGraph } from "./contradictions.ts";
import { type KnowledgeLinkGapPair, findLinkGaps } from "./gaps.ts";
import type { KnowledgeGraph } from "./graph.ts";
import {
  CLAIM_CONCEPT_TYPES,
  type KnowledgeClusterRef,
  type KnowledgeSimilarity,
  NON_TOPIC_CONCEPT_TYPES,
  distinctiveLimit,
  dot,
  newestFirst,
  round,
  scopeKey,
  yielder
} from "./similarity.ts";
import { type KnowledgeScope, entryInScope } from "./visibility.ts";

export const KNOWLEDGE_INSIGHTS_DEFAULT_LIMIT = 20;
export const KNOWLEDGE_INSIGHTS_MAX_LIMIT = 50;
/** How insights are derived; part of the cache key. */
const INSIGHTS_ALGORITHM = "insights-v1";
/** Insights responses (and, separately, link-gap lists) kept. */
const INSIGHTS_CACHE_SIZE = 8;
/** Other clusters a bridge's distinctive concepts must reach. */
const BRIDGE_MIN_CLUSTERS = 2;
/** Concepts named per bridge. */
const BRIDGE_CONCEPTS_MAX = 5;
/** The cluster size from which an unbacked claim counts (peers that could have said it and did not). */
const SINGLE_SOURCE_MIN_CLUSTER = 3;

export interface KnowledgeInsightsOptions {
  store: Pick<KnowledgeStorePort, "listMeta" | "getMeta">;
  graph: ContradictionGraph & Pick<KnowledgeGraph, "revision" | "conceptsOfEntry">;
  similarity: Pick<KnowledgeSimilarity, "graph">;
  /** The vector index, read per call; null while there is none. */
  index: () => KnowledgeVectorIndex | null;
  /** An entry as the read views show it. */
  summary: (meta: KnowledgeEntryMeta, scope: KnowledgeScope) => KnowledgeEntrySummary;
  /** Linking's LLM pair checks, read per call; absent or null: none. */
  pairChecks?: () => KnowledgePairChecksPort | null;
  /** Moves whenever the pair checks change; absent: never. */
  pairChecksRevision?: () => number;
  /** Whether the re-linker has queued both entries of a link gap (read per response); absent: never. */
  linkGapQueued?: (a: string, b: string) => boolean;
}

type Computed = Omit<KnowledgeInsightsResponse, "gaps"> & { gaps: (Omit<KnowledgeLinkGap, "queued"> & { pair: KnowledgeLinkGapPair })[] };

function remember<T>(cache: Map<string, Promise<T>>, key: string, make: () => Promise<T>): Promise<T> {
  let found = cache.get(key);
  if (found) {
    cache.delete(key); // most recently used last
    cache.set(key, found);
    return found;
  }
  const made = (found = make());
  cache.set(key, made);
  while (cache.size > INSIGHTS_CACHE_SIZE) cache.delete(cache.keys().next().value!);
  made.catch(() => {
    if (cache.get(key) === made) cache.delete(key);
  });
  return made;
}

export class KnowledgeInsights {
  private readonly options: KnowledgeInsightsOptions;
  /** Insertion order is least recently used first. */
  private readonly cache = new Map<string, Promise<Computed>>();
  private readonly gapCache = new Map<string, Promise<KnowledgeLinkGapPair[]>>();

  constructor(options: KnowledgeInsightsOptions) {
    this.options = options;
  }

  /** Contradictions, bridges, single-source concepts and link gaps over what `scope` lets through. */
  async list(query: { limit?: number }, scope: KnowledgeScope): Promise<KnowledgeInsightsResponse> {
    const limit =
      query.limit === undefined || !Number.isFinite(query.limit)
        ? KNOWLEDGE_INSIGHTS_DEFAULT_LIMIT
        : Math.max(1, Math.min(Math.floor(query.limit), KNOWLEDGE_INSIGHTS_MAX_LIMIT));
    const visible = this.options.store.listMeta().filter((meta) => entryInScope(meta, scope));
    const index = this.options.index();
    const thresholds = index?.thresholds() ?? null;
    const vectors = index && thresholds ? { index, thresholds } : null;
    const fingerprint = createHash("sha256");
    for (const meta of visible) fingerprint.update(`${meta.id}\u0000${meta.updatedAt}\u0000${meta.collections.join(",")}\u0001`);
    const visibleKey = fingerprint.digest("base64");
    const base = [scopeKey(scope), vectors?.index.modelId() ?? null, vectors?.thresholds ?? null, vectors?.index.generation() ?? null, this.options.graph.revision(), visibleKey];
    const gapsKey = JSON.stringify(base);
    const key = JSON.stringify([INSIGHTS_ALGORITHM, ...base, limit, this.options.pairChecksRevision?.() ?? 0]);

    const gaps = vectors
      ? remember(this.gapCache, gapsKey, () =>
          findLinkGaps({
            ids: visible.map((meta) => meta.id),
            index: vectors.index,
            conceptsOf: (id) => this.options.graph.conceptIdsOfEntry(id),
            minimum: vectors.thresholds.strong,
            limit: Number.POSITIVE_INFINITY
          })
        )
      : Promise.resolve([]);
    const computed = await remember(this.cache, key, () => this.compute(visible, scope, limit, vectors?.index ?? null, gaps));
    const queued = this.options.linkGapQueued ?? (() => false);
    return {
      contradictions: computed.contradictions.map(copy),
      bridges: computed.bridges.map(copy),
      singleSource: computed.singleSource.map(copy),
      gaps: computed.gaps.map(({ pair, ...gap }) => ({ ...copy(gap), queued: queued(pair.a, pair.b) })),
      totals: { ...computed.totals }
    };
  }

  private async compute(
    visible: readonly KnowledgeEntryMeta[],
    scope: KnowledgeScope,
    limit: number,
    index: KnowledgeVectorIndex | null,
    gapsReady: Promise<KnowledgeLinkGapPair[]>
  ): Promise<Computed> {
    const pause = yielder();
    const { graph, summary } = this.options;
    const metaOf = new Map(visible.map((meta) => [meta.id, meta]));
    const summaryOf = (id: string): KnowledgeEntrySummary => summary(metaOf.get(id)!, scope);

    // The similarity clusters (none without vectors).
    const drawn: KnowledgeSimilarityGraphResponse | null = index ? await this.options.similarity.graph({ limit: KNOWLEDGE_SIMILARITY_GRAPH_MAX_NODES }, scope) : null;
    const clusterOf = new Map<string, number>();
    for (const node of drawn?.nodes ?? []) clusterOf.set(node.id, node.cluster);
    const clusterRef = (cluster: number): KnowledgeClusterRef => ({ label: drawn!.clusters[cluster]!.label, size: drawn!.clusters[cluster]!.size });
    const clusterSize = (cluster: number): number => drawn!.clusters[cluster]!.size;

    // Each visible entry's concepts and each concept's visible entries.
    const conceptsOf = new Map<string, readonly KnowledgeConceptRef[]>();
    const entriesOf = new Map<string, string[]>();
    for (const meta of visible) {
      const concepts = graph.conceptsOfEntry(meta.id, scope);
      conceptsOf.set(meta.id, concepts);
      for (const concept of concepts) {
        let list = entriesOf.get(concept.id);
        if (!list) entriesOf.set(concept.id, (list = []));
        list.push(meta.id);
      }
      await pause();
    }
    const most = distinctiveLimit(visible.length);

    // Contradictions.
    const vectorOf = (id: string) => index?.entryVector(id) ?? null;
    const contradictions = [
      ...findContradictions({ graph, scope, pairChecks: this.options.pairChecks?.() ?? null, accept: (id) => metaOf.has(id) }).values()
    ].map((found) => {
      const [x, y] = [vectorOf(found.a), vectorOf(found.b)];
      return { ...found, similarity: x && y ? dot(x, y) : null };
    });
    contradictions.sort(
      (x, y) =>
        Number(y.source === "checked") - Number(x.source === "checked") ||
        (y.similarity ?? -Infinity) - (x.similarity ?? -Infinity) ||
        (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : 0)
    );
    await pause();

    // Bridges.
    const bridges: { meta: KnowledgeEntryMeta; own: number; reached: [number, Set<string>][]; concepts: KnowledgeConceptRef[] }[] = [];
    if (drawn) {
      for (const meta of visible) {
        const own = clusterOf.get(meta.id);
        if (own === undefined) continue;
        const reached = new Map<number, Set<string>>();
        const tying: KnowledgeConceptRef[] = [];
        for (const concept of conceptsOf.get(meta.id)!) {
          if (NON_TOPIC_CONCEPT_TYPES.has(concept.type.toLowerCase())) continue;
          const others = entriesOf.get(concept.id)!;
          if (others.length < 2 || others.length > most) continue;
          let ties = false;
          for (const other of others) {
            const cluster = other === meta.id ? undefined : clusterOf.get(other);
            if (cluster === undefined || cluster === own || clusterSize(cluster) < 2) continue;
            let concepts = reached.get(cluster);
            if (!concepts) reached.set(cluster, (concepts = new Set()));
            concepts.add(concept.id);
            ties = true;
          }
          if (ties) tying.push(concept);
        }
        if (reached.size >= BRIDGE_MIN_CLUSTERS) {
          const ordered = [...reached].sort((x, y) => y[1].size - x[1].size || x[0] - y[0]);
          bridges.push({ meta, own, reached: ordered, concepts: tying });
        }
        await pause();
      }
      bridges.sort((x, y) => y.reached.length - x.reached.length || y.concepts.length - x.concepts.length || newestFirst(x.meta, y.meta));
    }

    // Single-source claims, one per entry in turn.
    const perEntry: { meta: KnowledgeEntryMeta; cluster: number; concepts: KnowledgeConceptRef[] }[] = [];
    let singleSourceTotal = 0;
    if (drawn) {
      for (const meta of visible) {
        const cluster = clusterOf.get(meta.id);
        if (cluster === undefined || clusterSize(cluster) < SINGLE_SOURCE_MIN_CLUSTER) continue;
        const concepts = conceptsOf.get(meta.id)!.filter((concept) => CLAIM_CONCEPT_TYPES.has(concept.type.toLowerCase()) && entriesOf.get(concept.id)!.length === 1);
        if (concepts.length === 0) continue;
        perEntry.push({ meta, cluster, concepts });
        singleSourceTotal += concepts.length;
      }
      perEntry.sort((x, y) => clusterSize(y.cluster) - clusterSize(x.cluster) || newestFirst(x.meta, y.meta));
    }
    const singleSource: KnowledgeSingleSource[] = [];
    for (let turn = 0; singleSource.length < limit && perEntry.some((item) => item.concepts.length > turn); turn += 1) {
      for (const item of perEntry) {
        const concept = item.concepts[turn];
        if (!concept) continue;
        singleSource.push({ concept: { ...concept }, entry: summaryOf(item.meta.id), cluster: clusterRef(item.cluster) });
        if (singleSource.length >= limit) break;
      }
    }
    await pause();

    const gaps = await gapsReady;
    return {
      contradictions: contradictions.slice(0, limit).map(
        (found): KnowledgeContradiction => ({
          a: summaryOf(found.a),
          b: summaryOf(found.b),
          similarity: found.similarity === null ? null : round(found.similarity),
          source: found.source,
          pairs: found.pairs,
          note: found.note
        })
      ),
      bridges: bridges.slice(0, limit).map(
        (bridge): KnowledgeBridge => ({
          entry: summaryOf(bridge.meta.id),
          clusters: [clusterRef(bridge.own), ...bridge.reached.map(([cluster]) => clusterRef(cluster))],
          concepts: bridge.concepts.slice(0, BRIDGE_CONCEPTS_MAX).map((concept) => ({ ...concept }))
        })
      ),
      singleSource,
      gaps: gaps
        .filter((pair) => metaOf.has(pair.a) && metaOf.has(pair.b))
        .slice(0, limit)
        .map((pair) => ({ a: summaryOf(pair.a), b: summaryOf(pair.b), similarity: round(pair.similarity), pair })),
      totals: { contradictions: contradictions.length, bridges: bridges.length, singleSource: singleSourceTotal, gaps: gaps.length }
    };
  }
}

/** A deep copy of a cached, JSON-shaped value (callers may change what they are given). */
function copy<T>(value: T): T {
  return structuredClone(value);
}
