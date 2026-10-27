/**
 * Insights (phase 2 spec docs/superpowers/specs/2026-10-27-knowledge-phase2-cross-graph-design.md,
 * "Cross-graph derivations and insights"): what crossing the concept graph with the similarity
 * graph shows that neither shows alone, over the entries a scope lets through.
 *
 * - Contradictions: {@link findContradictions} over every visible pair; checked ones first, then
 *   by closeness in meaning plus {@link CENTRALITY_WEIGHT} × how central the contradicting
 *   concepts are to both entries ({@link conceptCentrality}).
 * - Bridges: entries whose distinctive concepts ({@link distinctiveLimit}; never a person or an
 *   organization) are shared with entries in at least 2 other clusters of two or more; most
 *   clusters first, then most such concepts, then newest.
 * - Single-source claims worth verifying: claims ({@link SINGLE_SOURCE_TYPES}) linked to exactly
 *   one visible entry (not a survey: {@link isSurveyEntry}) that sits in a cluster of 3 or more,
 *   that no other visible entry backs in other words (`KnowledgeGraph.backingConcepts`), and
 *   whose topic other entries of that cluster discuss: at least
 *   {@link SINGLE_SOURCE_MIN_PEERS} and {@link SINGLE_SOURCE_MIN_SHARE} of its other (non-survey)
 *   entries link to a concept the claim is linked to (never a person or an organization, nor a concept on most entries). Peers that
 *   discuss the topic and do not back the claim are what makes it worth checking. Ranked by what
 *   they came from (a saved post, thread or article before a note: {@link noteTier}), then centrality: the share of the cluster's peers that discuss its topic; taken one per entry in
 *   turn (entries by their most central claim), so one prolific entry does not fill the list.
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
import { findContradictions, isSurveyEntry, type ContradictionGraph } from "./contradictions.ts";
import { type KnowledgeLinkGapPair, findLinkGaps, linkGapConceptKey } from "./gaps.ts";
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
const INSIGHTS_ALGORITHM = "insights-v3";
/** Insights responses (and, separately, link-gap lists) kept. */
const INSIGHTS_CACHE_SIZE = 8;
/** Other clusters a bridge's distinctive concepts must reach. */
const BRIDGE_MIN_CLUSTERS = 2;
/** Concepts named per bridge. */
const BRIDGE_CONCEPTS_MAX = 5;
/**
 * Claims whose single source is worth checking: what someone did and what it gave. Not rules or
 * guidelines: those restate a platform's policy, one reference note per rule by design (126 real
 * entries: 20 of the first 50 single-source items were App Store Preflight rules, each the only note
 * on its rule), and the policy is checked against the platform, not against other entries.
 */
const SINGLE_SOURCE_TYPES: ReadonlySet<string> = new Set(["tactic", "result", "metric"]);
/** The cluster size from which an unbacked claim counts (peers that could have said it and did not). */
const SINGLE_SOURCE_MIN_CLUSTER = 3;
/**
 * Other entries of its cluster that must discuss a single-source claim's topic: at least 2, and at
 * least a quarter of them (126 real entries: 2,298 claims on one entry, 456 whose topic two peers
 * discuss, 208 whose topic a quarter of the cluster does).
 */
const SINGLE_SOURCE_MIN_PEERS = 2;
const SINGLE_SOURCE_MIN_SHARE = 0.25;
/**
 * A topic concept linked to more than this share of the visible entries ("TikTok" on a third of
 * them) says nothing about what a claim is about: it does not make a peer discuss its topic.
 */
const TOPIC_MAX_SHARE = 0.15;
/**
 * What how central the contradicting concepts are to their entries ({@link conceptCentrality}, 0..1)
 * weighs against closeness in meaning when contradictions are ranked: 0.1 lets a pair whose
 * concepts are what both entries are about pass a pair up to 0.05 closer whose concepts are a side
 * remark; meaning still decides between pairs further apart.
 */
const CENTRALITY_WEIGHT = 0.1;

export interface KnowledgeInsightsOptions {
  store: Pick<KnowledgeStorePort, "listMeta" | "getMeta">;
  graph: ContradictionGraph & Pick<KnowledgeGraph, "revision" | "conceptsOfEntry" | "neighbourLookup" | "canonicalConceptId" | "conceptType" | "backingConcepts" | "backingRevision">;
  similarity: Pick<KnowledgeSimilarity, "graph" | "clusterLabelsRevision">;
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
    // The clusters' LLM names are part of what insights show (a cluster ref's label).
    const key = JSON.stringify([INSIGHTS_ALGORITHM, ...base, limit, this.options.pairChecksRevision?.() ?? 0, this.options.similarity.clusterLabelsRevision(), this.options.graph.backingRevision()]);

    const gaps = vectors
      ? remember(this.gapCache, gapsKey, () =>
          findLinkGaps({
            ids: visible.map((meta) => meta.id),
            index: vectors.index,
            conceptsOf: (id) => this.options.graph.conceptsOfEntry(id, scope).map(linkGapConceptKey),
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
    const neighbours = graph.neighbourLookup(scope);
    const ownConcepts = new Map<string, ReadonlySet<string>>();
    const ownOf = (id: string): ReadonlySet<string> => {
      let set = ownConcepts.get(id);
      if (!set) ownConcepts.set(id, (set = new Set(graph.conceptIdsOfEntry(id))));
      return set;
    };
    const centrality = (conceptId: string, entryId: string): number => conceptCentrality(graph.canonicalConceptId(conceptId), ownOf(entryId), neighbours);
    const contradictions = [
      ...findContradictions({
        graph,
        scope,
        pairChecks: this.options.pairChecks?.() ?? null,
        accept: (id) => metaOf.has(id),
        entryMeta: (id) => metaOf.get(id) ?? null
      }).values()
    ].map((found) => {
      const [x, y] = [vectorOf(found.a), vectorOf(found.b)];
      const similarity = x && y ? dot(x, y) : null;
      // The best of its concept pairs, each as central as it is to the less engaged of the two entries.
      let central = 0;
      for (const { from, to } of found.pairs) {
        const fromA = ownOf(found.a).has(graph.canonicalConceptId(from.id));
        const [ofA, ofB] = fromA ? [from.id, to.id] : [to.id, from.id];
        central = Math.max(central, Math.min(centrality(ofA, found.a), centrality(ofB, found.b)));
      }
      return { ...found, similarity, rank: (similarity ?? 0) + CENTRALITY_WEIGHT * central };
    });
    contradictions.sort(
      (x, y) =>
        Number(y.source === "checked") - Number(x.source === "checked") ||
        Number(y.similarity !== null) - Number(x.similarity !== null) ||
        y.rank - x.rank ||
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

    // Single-source claims whose topic the entry's cluster discusses, one per entry in turn.
    const perEntry: { meta: KnowledgeEntryMeta; cluster: number; concepts: KnowledgeConceptRef[]; best: number }[] = [];
    let singleSourceTotal = 0;
    if (drawn) {
      const members = new Map<number, string[]>();
      for (const meta of visible) {
        const cluster = clusterOf.get(meta.id);
        if (cluster === undefined || isSurveyEntry(meta)) continue;
        let list = members.get(cluster);
        if (!list) members.set(cluster, (list = []));
        list.push(meta.id);
      }
      const topicMax = Math.max(SINGLE_SOURCE_MIN_PEERS, visible.length * TOPIC_MAX_SHARE);
      const topic = new Map<string, boolean>();
      /** Whether a concept says what a claim is about: not who said it, not on most entries. */
      const isTopic = (conceptId: string): boolean => {
        let is = topic.get(conceptId);
        if (is === undefined) {
          const type = graph.conceptType(conceptId)?.toLowerCase() ?? null;
          is = type !== null && !NON_TOPIC_CONCEPT_TYPES.has(type) && graph.visibleEntriesOf(conceptId, scope).length <= topicMax;
          topic.set(conceptId, is);
        }
        return is;
      };
      for (const meta of visible) {
        const cluster = clusterOf.get(meta.id);
        if (cluster === undefined || clusterSize(cluster) < SINGLE_SOURCE_MIN_CLUSTER || isSurveyEntry(meta)) continue;
        const peers = (members.get(cluster) ?? []).filter((id) => id !== meta.id);
        if (peers.length < SINGLE_SOURCE_MIN_PEERS) continue;
        const scored: { concept: KnowledgeConceptRef; peers: number }[] = [];
        for (const concept of conceptsOf.get(meta.id)!) {
          if (!SINGLE_SOURCE_TYPES.has(concept.type.toLowerCase()) || entriesOf.get(concept.id)!.length !== 1) continue;
          const topics = neighbours(graph.canonicalConceptId(concept.id)).filter(isTopic);
          if (topics.length === 0) continue;
          let discussing = 0;
          for (const peer of peers) if (topics.some((id) => ownOf(peer).has(id))) discussing += 1;
          if (discussing < Math.max(SINGLE_SOURCE_MIN_PEERS, SINGLE_SOURCE_MIN_SHARE * peers.length)) continue;
          // Another entry says it in other words: backed, not single-source.
          if (graph.backingConcepts(concept.id).some((other) => graph.visibleEntriesOf(other, scope).some((id) => id !== meta.id && metaOf.has(id)))) continue;
          scored.push({ concept, peers: discussing });
        }
        if (scored.length === 0) continue;
        scored.sort((x, y) => y.peers - x.peers);
        perEntry.push({ meta, cluster, concepts: scored.map((item) => item.concept), best: scored[0]!.peers / peers.length });
        singleSourceTotal += scored.length;
        await pause();
      }
      perEntry.sort((x, y) => noteTier(x.meta) - noteTier(y.meta) || y.best - x.best || clusterSize(y.cluster) - clusterSize(x.cluster) || newestFirst(x.meta, y.meta));
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

/**
 * How central a concept is to an entry: the share of the entry's concepts that are it or one of its
 * neighbours (0..1). A concept tied into most of what an entry says is what it is about; one tied
 * to nothing else in a 150-concept guide is a side remark.
 */
export function conceptCentrality(conceptId: string, entryConcepts: ReadonlySet<string>, neighbours: (conceptId: string) => readonly string[]): number {
  if (entryConcepts.size === 0) return 0;
  let near = entryConcepts.has(conceptId) ? 1 : 0;
  for (const id of new Set(neighbours(conceptId))) if (entryConcepts.has(id)) near += 1;
  return near / entryConcepts.size;
}

/**
 * Where a single-source claim ranks by what it came from: 0 for a source someone saved (a post, a
 * thread, an article, a video: a practitioner's claim, the one worth checking), 1 for a note (a
 * research or reference note: already a check, or a restated policy).
 */
function noteTier(meta: Pick<KnowledgeEntryMeta, "kind">): number {
  return /^(research[ _-]?|reference[ _-]?)?notes?$/i.test((meta.kind ?? "").trim()) ? 1 : 0;
}

/** A deep copy of a cached, JSON-shaped value (callers may change what they are given). */
function copy<T>(value: T): T {
  return structuredClone(value);
}
