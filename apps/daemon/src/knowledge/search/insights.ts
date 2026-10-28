/**
 * Insights (phase 2 spec docs/superpowers/specs/2026-10-27-knowledge-phase2-cross-graph-design.md,
 * "Cross-graph derivations and insights"): what crossing the concept graph with the similarity
 * graph shows that neither shows alone, over the entries a scope lets through.
 *
 * - Contradictions: {@link findContradictions} over every visible pair, strongest first: checked
 *   ones; then a note that is not vague ({@link noteStrength}: figures that meet, "a few days");
 *   saved posts by different authors before a note's side ({@link sidesTier}); concrete opposing
 *   claims (figures apart, "only Gmail", "not to use NordVPN") before the rest; then by closeness in
 *   meaning plus {@link CENTRALITY_WEIGHT} × how central the contradicting concepts are to both
 *   entries ({@link conceptCentrality}). 126 real entries: "Alex (1–2 days) vs Erikas (a few days)"
 *   was first, now Outlook vs Gmail; 5–7 vs 3–5 days last. One that makes the same point against
 *   the same entry as one ranked above it ({@link samePoint}) is folded into it as `also`, each
 *   entry once, and by the side it joins (`alsoJoins`): the side it does not disagree with as well
 *   (an entry that disagrees with both sides joins neither, and its disagreements are shown).
 * - Bridges: entries (never a survey: {@link isSurveyEntry}) whose distinctive concepts
 *   ({@link distinctiveLimit}, by id and by name in any type; never a person, an organization, a
 *   product or an app: a named example) are shared with non-survey entries in at least 2 other
 *   clusters of two or more, each cluster tied by a strong claim ({@link bridgeStrong}: advice, or
 *   a result with a figure), or else by two concepts; most clusters first, then most such concepts,
 *   then newest. 126 real entries: 36 bridges, the first eight surveys or hubs, many tied by "iOS"
 *   or "CAC" alone; 6 after.
 * - Single-source claims worth verifying: claims ({@link SINGLE_SOURCE_TYPES}) linked to exactly
 *   one visible entry (not a survey: {@link isSurveyEntry}) that sits in a cluster of 3 or more,
 *   that no other visible entry backs in other words (`KnowledgeGraph.backingConcepts`), states
 *   the figure of (`stating`) or answers the same question of (`KnowledgeGraph.sameQuestion`, or
 *   for a compound claim its main step: `answeredElsewhereTest`; 126 real entries: 73 → 58, "Create a
 *   new iCloud account with fresh Gmail and Apple ID" gone, its iCloud account step being Ema's
 *   too), that do not name the entry's or its cluster's topic (`namesTopic`: its title, the cluster's
 *   label, a concept most of the cluster's entries link to) nor are a metric
 *   that states nothing ({@link statesNoClaim}), and whose topic other entries of that cluster discuss: at least
 *   {@link SINGLE_SOURCE_MIN_PEERS} and {@link SINGLE_SOURCE_MIN_SHARE} of its other (non-survey)
 *   entries link to a concept the claim is linked to (never a person or an organization, nor a concept on most entries). Peers that
 *   discuss the topic and do not back the claim are what makes it worth checking. Ranked by what
 *   they came from (a saved post, thread or article before a note: {@link noteTier}), then centrality: the share of the cluster's peers that discuss its topic; taken one per entry in
 *   turn (entries by their most central claim), so one prolific entry does not fill the list.
 * - Link gaps: {@link findLinkGaps} at the model's `strong` threshold over non-survey entries, and
 *   once concept vectors are ready only pairs a claim of one is close to a claim of the other
 *   ({@link KnowledgeInsights.claimsClose}); `queued` from the re-linker.
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
import { type ContradictionGraph, type KnowledgeContradictionFound, findContradictions, isSurveyEntry, pairKeyOf } from "./contradictions.ts";
import { type KnowledgeLinkGapPair, findLinkGaps, linkGapConceptKey } from "./gaps.ts";
import type { KnowledgeGraph } from "./graph.ts";
import {
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
import { answeredElsewhereTest, conceptsByType, namesTopic } from "./same-question.ts";
import { tokenize } from "./text.ts";
import { type KnowledgeScope, entryInScope } from "./visibility.ts";

export const KNOWLEDGE_INSIGHTS_DEFAULT_LIMIT = 20;
export const KNOWLEDGE_INSIGHTS_MAX_LIMIT = 50;
/** How insights are derived; part of the cache key. */
const INSIGHTS_ALGORITHM = "insights-v5";
/** Insights responses (and, separately, link-gap lists) kept. */
const INSIGHTS_CACHE_SIZE = 8;
/** Other clusters a bridge's distinctive concepts must reach. */
const BRIDGE_MIN_CLUSTERS = 2;
/** Concepts named per bridge. */
const BRIDGE_CONCEPTS_MAX = 5;
/** Concept types that name an example (a product or an app a post is about) rather than a topic: they tie no bridge. */
const BRIDGE_EXAMPLE_TYPES: ReadonlySet<string> = new Set(["product", "app"]);
/**
 * Claims whose single source is worth checking: what someone did and what it gave. Not rules or
 * guidelines: those restate a platform's policy, one reference note per rule by design (126 real
 * entries: 20 of the first 50 single-source items were App Store Preflight rules, each the only note
 * on its rule), and the policy is checked against the platform, not against other entries.
 */
const SINGLE_SOURCE_TYPES: ReadonlySet<string> = new Set(["tactic", "result", "metric"]);
/**
 * Claims a link gap's topical test compares (126 real entries, 12 gaps at `strong`: in the 4 where
 * a tactic of one has a close one in the other, the two name one practice twice, such as "Post
 * twice a day then once a day" and "2 posts per account per day"; the 8 without are neighbours by
 * genre: "Claude prompt to find your aha moment" ~ "polling and v2 fallbacks", whose closest
 * concepts are "Downloads" ~ "Podcast downloads" or "ChatGPT" ~ "TikTok"). Not metrics or named
 * things: siblings of one kind score as close as one thing does.
 */
const GAP_CLAIM_TYPES: ReadonlySet<string> = new Set(["tactic", "rule", "guideline", "result"]);
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
  graph: ContradictionGraph &
    Pick<
      KnowledgeGraph,
      | "revision"
      | "conceptsOfEntry"
      | "neighbourLookup"
      | "canonicalConceptId"
      | "conceptType"
      | "backingConcepts"
      | "backingRevision"
      | "similarConceptIds"
      | "conceptVectorsReady"
      | "sameQuestion"
      | "answersSameQuestions"
      | "commonConceptWords"
    >;
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
  /**
   * The entries whose text states a claim's figure (`KnowledgeSearch.entriesStating`), unscoped: a
   * figure another visible entry states is no single source. Absent: none.
   */
  stating?: (claim: string) => readonly string[];
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
    // Concept vectors (what the gaps' topical test and backing read) are part of both keys.
    const gapsKey = JSON.stringify([INSIGHTS_ALGORITHM, ...base, this.options.graph.backingRevision()]);
    // The clusters' LLM names are part of what insights show (a cluster ref's label).
    const key = JSON.stringify([INSIGHTS_ALGORITHM, ...base, limit, this.options.pairChecksRevision?.() ?? 0, this.options.similarity.clusterLabelsRevision(), this.options.graph.backingRevision()]);

    const gaps = vectors
      ? remember(this.gapCache, gapsKey, () =>
          findLinkGaps({
            // A survey is close to what it surveys and links its own concepts: never a side of a gap.
            ids: visible.filter((meta) => !isSurveyEntry(meta)).map((meta) => meta.id),
            index: vectors.index,
            conceptsOf: (id) => this.options.graph.conceptsOfEntry(id, scope).map(linkGapConceptKey),
            minimum: vectors.thresholds.strong,
            limit: Number.POSITIVE_INFINITY,
            related: this.claimsClose(scope)
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

  /**
   * A link gap's topical test: a claim of one entry ({@link GAP_CLAIM_TYPES}) has a concept close
   * in meaning (`KnowledgeGraph.similarConceptIds`) among the other's. Two entries merely close in
   * meaning ("polling and v2 fallbacks" and "Reddit's push budgeter": both app engineering) pass
   * no claim of theirs between them. Absent (every pair) while concept vectors are not ready.
   */
  private claimsClose(scope: KnowledgeScope): ((a: string, b: string) => boolean) | undefined {
    const graph = this.options.graph;
    const claims = new Map<string, string[]>();
    const claimsOf = (id: string): string[] => {
      let list = claims.get(id);
      if (!list) {
        claims.set(id, (list = graph.conceptsOfEntry(id, scope).filter((c) => GAP_CLAIM_TYPES.has(c.type.toLowerCase())).map((c) => graph.canonicalConceptId(c.id))));
      }
      return list;
    };
    if (!graph.conceptVectorsReady()) return undefined;
    const near = new Map<string, readonly string[]>();
    const nearOf = (conceptId: string): readonly string[] => {
      let list = near.get(conceptId);
      if (!list) near.set(conceptId, (list = graph.similarConceptIds(conceptId) ?? []));
      return list;
    };
    const close = (x: string, y: string): boolean => {
      const theirs = new Set(claimsOf(y));
      return claimsOf(x).some((id) => nearOf(id).some((other) => theirs.has(other)));
    };
    return (a, b) => close(a, b) || close(b, a);
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
    const pairChecks = this.options.pairChecks?.() ?? null;
    const contradictions = [
      ...findContradictions({
        graph,
        scope,
        pairChecks,
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
      const strength = noteStrength(found.note);
      return { ...found, similarity, rank: (similarity ?? 0) + CENTRALITY_WEIGHT * central, sides: sidesTier(metaOf.get(found.a)!, metaOf.get(found.b)!), strength };
    });
    // Strongest first ({@link noteStrength}, {@link sidesTier}): checked, not vague, saved posts by
    // different authors before notes, concrete opposing claims before the rest; then the closest.
    contradictions.sort(
      (x, y) =>
        Number(y.source === "checked") - Number(x.source === "checked") ||
        Number(y.strength !== "vague") - Number(x.strength !== "vague") ||
        x.sides - y.sides ||
        Number(y.strength === "concrete") - Number(x.strength === "concrete") ||
        Number(y.similarity !== null) - Number(x.similarity !== null) ||
        y.rank - x.rank ||
        (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : 0)
    );
    // The same point against the same entry, made by several: shown once, the others as "also".
    // `found` (X against O) joins a kept pair (S against O) on S's side only when X does not
    // disagree with S too: an entry that disagrees with both sides joins neither (its own
    // disagreements are shown as they are). A pair check that found X and S consistent says they
    // agree: then fewer note words in common make the same point ({@link samePoint}'s `agreed`).
    const disagree = new Set(contradictions.map((found) => pairKeyOf(found.a, found.b)));
    const agreed = (x: string, y: string): boolean => pairChecks?.get(x, y)?.verdict === "consistent";
    const shown: ((typeof contradictions)[number] & { joins: { a: string[]; b: string[] } })[] = [];
    for (const found of contradictions) {
      let folded = false;
      for (const twin of shown) {
        const shared = twin.a === found.a || twin.a === found.b ? twin.a : twin.b === found.a || twin.b === found.b ? twin.b : null;
        if (shared === null) continue;
        const other = found.a === shared ? found.b : found.a;
        const joined = shared === twin.a ? twin.b : twin.a;
        if (disagree.has(pairKeyOf(other, joined))) continue;
        if (!samePoint(twin, found, (id) => metaOf.get(id) ?? null, { agreed: agreed(other, joined) })) continue;
        const side = joined === twin.a ? twin.joins.a : twin.joins.b;
        if (!side.includes(other)) side.push(other);
        folded = true;
        break;
      }
      if (!folded) shown.push({ ...found, joins: { a: [], b: [] } });
    }
    await pause();

    // Bridges.
    const bridges: { meta: KnowledgeEntryMeta; own: number; reached: [number, Set<string>][]; concepts: KnowledgeConceptRef[] }[] = [];
    if (drawn) {
      // Entries linked to a concept's name in any type ("iOS" as a Channel and as a Platform).
      const entriesByName = new Map<string, Set<string>>();
      for (const [id, concepts] of conceptsOf) {
        for (const concept of concepts) {
          const key = linkGapConceptKey(concept);
          let set = entriesByName.get(key);
          if (!set) entriesByName.set(key, (set = new Set()));
          set.add(id);
        }
      }
      const surveyOf = new Map(visible.map((meta) => [meta.id, isSurveyEntry(meta)]));
      for (const meta of visible) {
        const own = clusterOf.get(meta.id);
        // A survey restates its sources: it ties clusters by construction, it bridges nothing.
        if (own === undefined || surveyOf.get(meta.id)) continue;
        const reached = new Map<number, { concepts: Set<string>; strong: boolean }>();
        const tying: KnowledgeConceptRef[] = [];
        for (const concept of conceptsOf.get(meta.id)!) {
          // A named example (a product, an app, a person, an organization) is no shared topic.
          if (NON_TOPIC_CONCEPT_TYPES.has(concept.type.toLowerCase()) || BRIDGE_EXAMPLE_TYPES.has(concept.type.toLowerCase())) continue;
          const others = entriesOf.get(concept.id)!;
          if (others.length < 2 || others.length > most || entriesByName.get(linkGapConceptKey(concept))!.size > most) continue;
          const strong = bridgeStrong(concept);
          let ties = false;
          for (const other of others) {
            const cluster = other === meta.id || surveyOf.get(other) ? undefined : clusterOf.get(other);
            if (cluster === undefined || cluster === own || clusterSize(cluster) < 2) continue;
            let tie = reached.get(cluster);
            if (!tie) reached.set(cluster, (tie = { concepts: new Set(), strong: false }));
            tie.concepts.add(concept.id);
            tie.strong ||= strong;
            ties = true;
          }
          if (ties) tying.push(concept);
        }
        // A cluster reached through one weak concept alone ("CAC") is no bridge to it.
        const kept = [...reached].filter(([, tie]) => tie.strong || tie.concepts.size >= 2);
        if (kept.length >= BRIDGE_MIN_CLUSTERS) {
          const keptConcepts = new Set(kept.flatMap(([, tie]) => [...tie.concepts]));
          const ordered = kept.sort((x, y) => y[1].concepts.size - x[1].concepts.size || x[0] - y[0]).map(([cluster, tie]): [number, Set<string>] => [cluster, tie.concepts]);
          bridges.push({ meta, own, reached: ordered, concepts: tying.filter((concept) => keptConcepts.has(concept.id)).sort((x, y) => Number(bridgeStrong(y)) - Number(bridgeStrong(x))) });
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
      // What each cluster is about: its label, and the concepts (not people) most of its entries link to.
      const clusterTopics = new Map<number, string[]>();
      const topicsOf = (cluster: number): string[] => {
        let list = clusterTopics.get(cluster);
        if (!list) {
          const label = drawn.clusters[cluster]?.label ?? null;
          list = label ? [label] : [];
          const ids = members.get(cluster) ?? [];
          const counts = new Map<string, { name: string; count: number }>();
          for (const id of ids) {
            for (const concept of conceptsOf.get(id)!) {
              if (NON_TOPIC_CONCEPT_TYPES.has(concept.type.toLowerCase())) continue;
              const seen = counts.get(concept.id);
              if (seen) seen.count += 1;
              else counts.set(concept.id, { name: concept.name, count: 1 });
            }
          }
          for (const { name, count } of counts.values()) if (count * 2 > ids.length) list.push(name);
          clusterTopics.set(cluster, list);
        }
        return list;
      };
      // Another visible entry answering a claim's question: any concept of the visible entries linked to one other than the claim's.
      let answered: ReturnType<typeof answeredElsewhereTest> | null = null;
      const answeredTest = () =>
        (answered ??= answeredElsewhereTest(
          conceptsByType(metaOf.keys(), (id) => conceptsOf.get(id)!),
          graph.answersSameQuestions() ? (a, b) => graph.sameQuestion(a, b) : null,
          graph.commonConceptWords()
        ));
      for (const meta of visible) {
        const cluster = clusterOf.get(meta.id);
        if (cluster === undefined || clusterSize(cluster) < SINGLE_SOURCE_MIN_CLUSTER || isSurveyEntry(meta)) continue;
        const peers = (members.get(cluster) ?? []).filter((id) => id !== meta.id);
        if (peers.length < SINGLE_SOURCE_MIN_PEERS) continue;
        const scored: { concept: KnowledgeConceptRef; peers: number }[] = [];
        const named = [meta.title, ...topicsOf(cluster)];
        for (const concept of conceptsOf.get(meta.id)!) {
          if (!SINGLE_SOURCE_TYPES.has(concept.type.toLowerCase()) || entriesOf.get(concept.id)!.length !== 1) continue;
          // The entry's or its cluster's topic ("Start an app from zero with $300…" on that title), or a metric it only names ("Payment conversion rate").
          if (named.some((topic) => namesTopic(concept.name, topic)) || statesNoClaim(concept)) continue;
          const topics = neighbours(graph.canonicalConceptId(concept.id)).filter(isTopic);
          if (topics.length === 0) continue;
          let discussing = 0;
          for (const peer of peers) if (topics.some((id) => ownOf(peer).has(id))) discussing += 1;
          if (discussing < Math.max(SINGLE_SOURCE_MIN_PEERS, SINGLE_SOURCE_MIN_SHARE * peers.length)) continue;
          // Another entry says it in other words: backed, not single-source.
          if (graph.backingConcepts(concept.id).some((other) => graph.visibleEntriesOf(other, scope).some((id) => id !== meta.id && metaOf.has(id)))) continue;
          // Another entry states its figure in its text ("Candy Crush (231 configurable settings)").
          if (this.options.stating?.(concept.name).some((id) => id !== meta.id && metaOf.has(id))) continue;
          // Another entry answers the same question, or names a compound's main step ("Create a new iCloud account …").
          if (answeredTest()(concept, (other) => (entriesOf.get(other.id) ?? []).some((id) => id !== meta.id))) continue;
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
      contradictions: shown.slice(0, limit).map(
        (found): KnowledgeContradiction => ({
          a: summaryOf(found.a),
          b: summaryOf(found.b),
          similarity: found.similarity === null ? null : round(found.similarity),
          source: found.source,
          pairs: found.pairs,
          note: found.note,
          ...(found.joins.a.length + found.joins.b.length > 0
            ? {
                also: [...new Set([...found.joins.a, ...found.joins.b])].map(summaryOf),
                alsoJoins: { a: found.joins.a.map(summaryOf), b: found.joins.b.map(summaryOf) }
              }
            : {})
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
      totals: { contradictions: shown.length, bridges: bridges.length, singleSource: singleSourceTotal, gaps: gaps.length }
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
 * Whether a concept ties two entries on its own: a strong claim, advice (a tactic or guideline) or a
 * result that states a figure ("Views on a new IG account" states none). A rule (one App Store rule
 * cited by a teardown and a checklist), a metric, a thing or a screen ("Screen 6") is common ground,
 * not a topic: it ties a bridge's cluster only beside another concept. 126 real entries: "83% beats
 * 80%" tied to the App Store cluster by "Screen 6" and "Penelope's pregnancy app", the $100k/day
 * teardown by one review-gating Rule.
 */
function bridgeStrong(concept: KnowledgeConceptRef): boolean {
  const type = concept.type.toLowerCase();
  if (type === "tactic" || type === "guideline") return true;
  return type === "result" && /\d/.test(concept.name);
}

/** Words that give a metric a direction ("Paywall conversion up 20%", "Churn lower on annual plans"). */
const DIRECTION_WORDS: ReadonlySet<string> = new Set(
  (
    "up down more less fewer higher lower increase increases increased decrease decreases decreased rise rises rose fall falls fell drop drops " +
    "dropped grow grows grew raise raises raised cut cuts lift lifts double doubles doubled triple tripled beat beats better worse best worst " +
    "improve improves improved outperform outperforms above below over under vs versus"
  ).split(" ")
);

/** Whether a concept is a metric that states no claim: no number and no direction, only what is measured ("Payment conversion rate"). */
export function statesNoClaim(concept: Pick<KnowledgeConceptRef, "name" | "type">): boolean {
  if (concept.type.toLowerCase() !== "metric" || /\d|%/.test(concept.name)) return false;
  return !concept.name
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .some((word) => DIRECTION_WORDS.has(word));
}

/**
 * A contradiction's sides, strongest first: 0 for two saved sources ({@link noteTier} 0) by different
 * authors, 1 for one note (or one author's two posts), 2 for two notes.
 */
function sidesTier(a: Pick<KnowledgeEntryMeta, "kind" | "author" | "handle">, b: Pick<KnowledgeEntryMeta, "kind" | "author" | "handle">): number {
  const notes = noteTier(a) + noteTier(b);
  if (notes > 0) return notes;
  const who = (meta: Pick<KnowledgeEntryMeta, "author" | "handle">): string | null => (meta.handle ?? meta.author)?.trim().replace(/^@+/, "").toLowerCase() || null;
  return who(a) !== null && who(a) === who(b) ? 1 : 0;
}

/** A number or a range of two ("3-5", "1–2", "5 to 7") before a unit, up to one word apart ("2-3 TikTok accounts", "48h", "3-day"). */
const FIGURE =
  /(?<![\p{L}\p{N}.])(\d+(?:\.\d+)?)(?:\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?))?(?:\s*-\s*|\s*)(?:(?!(?:per|a|an|each|every|in|of|on|or|and)\b)([\p{L}]+)\s+)?(hours?|hrs?|h|days?|d|weeks?|months?|minutes?|mins?|accounts?|videos?|posts?|devices?|iphones?|phones?)\b/giu;
/** Units a figure is compared in: time (in hours), and counts of one kind of thing. */
const UNITS: Record<string, [string, number]> = {
  h: ["time", 1],
  hr: ["time", 1],
  hour: ["time", 1],
  d: ["time", 24],
  day: ["time", 24],
  week: ["time", 168],
  month: ["time", 720],
  min: ["minute", 1],
  minute: ["minute", 1],
  account: ["account", 1],
  video: ["post", 1],
  post: ["post", 1],
  device: ["device", 1],
  phone: ["device", 1],
  iphone: ["device", 1]
};
/** An amount said without a figure ("a few days", "several accounts", "some time"). */
const VAGUE_AMOUNT = /\b(a few|several|a couple(?: of)?|some)\s+(?:[\p{L}-]+\s+)?(hours?|days?|weeks?|months?|minutes?|time|times|videos?|posts?|accounts?|devices?)\b/iu;
/** A side's opposing claim in words: "only X", "never", "avoid", "not to use", "advises against". */
const OPPOSING =
  /\b(only|never|avoid|advises? against|not to (?:use|run|buy|post|create|install|connect)|(?:don['’]t|do not|does not|should not|shouldn['’]t) (?:use|run|buy|post|create|install|connect))\b/i;

/**
 * How clearly a contradiction's note opposes two claims (null: no note, "plain"):
 * - "vague": no two of its figures of one unit are apart, and two meet or overlap ("5-7 days" and
 *   "3-5 days") or it says an amount without a figure ("a few days");
 * - "concrete": two figures of one unit are apart ("48 hours" and "3 days"; "2-3 accounts" and "5
 *   accounts"), or a side's claim is opposing in words ("use only Gmail", "not to use NordVPN");
 * - "plain": anything else.
 */
export function noteStrength(note: string | null): "concrete" | "plain" | "vague" {
  if (!note) return "plain";
  const byUnit = new Map<string, [number, number][]>();
  for (const match of note.matchAll(FIGURE)) {
    const unit = UNITS[match[4]!.toLowerCase().replace(/s$/, "")];
    if (!unit) continue;
    const [lo, hi] = [Number(match[1]) * unit[1], Number(match[2] ?? match[1]) * unit[1]];
    let list = byUnit.get(unit[0]);
    if (!list) byUnit.set(unit[0], (list = []));
    if (!list.some(([x, y]) => x === lo && y === hi)) list.push([Math.min(lo, hi), Math.max(lo, hi)]);
  }
  let apart = false;
  let meet = false;
  for (const list of byUnit.values()) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const [[a, b], [c, d]] = [list[i]!, list[j]!];
        if (b < c || d < a) apart = true;
        else meet = true;
      }
    }
  }
  if (!apart && (meet || VAGUE_AMOUNT.test(note))) return "vague";
  return apart || OPPOSING.test(note) ? "concrete" : "plain";
}

/**
 * Where a single-source claim ranks by what it came from: 0 for a source someone saved (a post, a
 * thread, an article, a video: a practitioner's claim, the one worth checking), 1 for a note (a
 * research or reference note: already a check, or a restated policy).
 */
function noteTier(meta: Pick<KnowledgeEntryMeta, "kind">): number {
  return /^(research[ _-]?|reference[ _-]?)?notes?$/i.test((meta.kind ?? "").trim()) ? 1 : 0;
}

/**
 * How much of the shorter note's words (the sides' names and the words every note uses aside) the
 * other must hold for two disagreements with one entry to make the same point. 126 real entries:
 * the two research notes against daniel's self-hosted VPN ("a self-hosted Hetzner VPS makes TikTok
 * see a normal US home user" vs "IP-intelligence vendors label it datacenter", and vs "a
 * residential-looking IP beats a datacenter one") share 0.6; jason's ISP proxy and Ema's NordVPN
 * against daniel share 0.3 or less with them.
 */
const SAME_POINT_NOTE_OVERLAP = 0.5;
/**
 * The share of the folded note's words the kept one must hold when a pair check found the two
 * entries against the one consistent (they agree). 126 real entries: Claude (research)'s note
 * against yanme's 5 accounts per device has 0.46 of its words in Alex Nguyen's (which also speaks of
 * warm-up); Alex's two-point note against yanme is not folded into Evgeniy's one-point warm-up note.
 */
const SAME_POINT_AGREED_OVERLAP = 0.4;
/** Words every note uses to say who claims what: no part of the point. */
const NOTE_FILLER: ReadonlySet<string> = new Set(tokenize("say says said claim claims recommend recommends argue argues state states report reports note research entry side both while whereas"));

/** A note's words as {@link samePoint} compares them: tokens of 3+ characters, -ing and -ed folded, filler and `names` left out. */
function pointWords(note: string, names: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const token of tokenize(note)) {
    if (token.length < 3 || NOTE_FILLER.has(token) || names.has(token)) continue;
    out.add(token.length > 5 && token.endsWith("ing") ? token.slice(0, -3) : token.length > 4 && token.endsWith("ed") ? token.slice(0, -2) : token);
  }
  return out;
}

/**
 * Whether two contradictions make the same point against the same entry: they share exactly one
 * side, and either share a concept pair (the same two concepts, either way round) or their notes say
 * much the same ({@link SAME_POINT_NOTE_OVERLAP}, the four entries' authors' and handles' words aside;
 * or, when `agreed` (a pair check found their other two entries consistent), `x`'s note holds
 * {@link SAME_POINT_AGREED_OVERLAP} of `y`'s words).
 */
export function samePoint(
  x: Pick<KnowledgeContradictionFound, "a" | "b" | "pairs" | "note">,
  y: Pick<KnowledgeContradictionFound, "a" | "b" | "pairs" | "note">,
  metaOf: (id: string) => Pick<KnowledgeEntryMeta, "author" | "handle"> | null,
  options: { agreed?: boolean } = {}
): boolean {
  if ([x.a, x.b].filter((id) => id === y.a || id === y.b).length !== 1) return false;
  const key = (pair: { from: KnowledgeConceptRef; to: KnowledgeConceptRef }): string => [pair.from.id, pair.to.id].sort().join("\u0000");
  const pairs = new Set(x.pairs.map(key));
  if (y.pairs.some((pair) => pairs.has(key(pair)))) return true;
  if (x.note === null || y.note === null) return false;
  const names = new Set<string>();
  for (const id of [x.a, x.b, y.a, y.b]) {
    const meta = metaOf(id);
    for (const token of tokenize(`${meta?.author ?? ""} ${meta?.handle ?? ""}`)) names.add(token);
  }
  const [wx, wy] = [pointWords(x.note, names), pointWords(y.note, names)];
  if (wx.size === 0 || wy.size === 0) return false;
  let shared = 0;
  for (const word of wx) if (wy.has(word)) shared += 1;
  if (shared >= SAME_POINT_NOTE_OVERLAP * Math.min(wx.size, wy.size)) return true;
  // Agreeing: `y`'s note is mostly in `x`'s (never `y`'s second point lost in `x`'s one).
  return options.agreed === true && shared >= SAME_POINT_AGREED_OVERLAP * wy.size;
}

/** A deep copy of a cached, JSON-shaped value (callers may change what they are given). */
function copy<T>(value: T): T {
  return structuredClone(value);
}
