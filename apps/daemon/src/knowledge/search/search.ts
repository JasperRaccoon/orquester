import { createHash } from "node:crypto";
import {
  KNOWLEDGE_GRAPH_MAX_NODES,
  KNOWLEDGE_SEARCH_DEFAULT_LIMIT,
  KNOWLEDGE_SEARCH_MAX_LIMIT,
  KNOWLEDGE_SEARCH_MAX_RESULTS,
  KNOWLEDGE_SIMILAR_MAX_EXAMPLES,
  knowledgeCitation,
  type KnowledgeCollection,
  type KnowledgeConceptDetail,
  type KnowledgeConceptRef,
  type KnowledgeEntriesQuery,
  type KnowledgeEntriesResponse,
  type KnowledgeEntryDetail,
  type KnowledgeEntryMatch,
  type KnowledgeEntryMeta,
  type KnowledgeEntrySummary,
  type KnowledgeGraphResponse,
  type KnowledgeItemResponse,
  type KnowledgeMatchBand,
  type KnowledgeMatchSignal,
  type KnowledgeSearchHit,
  type KnowledgeSearchRequest,
  type KnowledgeSearchResponse,
  type KnowledgeSearchSort,
  type KnowledgeVisibility
} from "@orquester/api";
import { isKnowledgeEntryId } from "@orquester/config";
import type { KnowledgeEntryChange, KnowledgeStorePort, KnowledgeVectorHit, KnowledgeVectorIndex, KnowledgeVectorThresholds } from "../ports.ts";
import type { KnowledgePairChecksPort } from "../ports.ts";
import { KnowledgeError, type KnowledgeLogger } from "../store/errors.ts";
import { Bm25Index } from "./bm25.ts";
import type { KnowledgeEmbedderSource } from "./embedder.ts";
import { type KnowledgeEntryFilter, entryMatchesFilter, filterKey, parseKnowledgeFilters, splitFilterList } from "./filters.ts";
import type { KnowledgeGraph } from "./graph.ts";
import { computeKnowledgeFacets } from "./facets.ts";
import type { KnowledgeConceptFamilySummariesPort } from "./concept-family-summaries.ts";
import type { KnowledgeConceptSummariesPort } from "./concept-summaries.ts";
import { findContradictions, isSurveyEntry } from "./contradictions.ts";
import { KnowledgeSimilarity } from "./similarity.ts";
import { KnowledgeInsights } from "./insights.ts";
import { claimFigure, namesPhrase, statesClaimNumber } from "./mentions.ts";
import { type AnswerShape, DURATION, type TextSpan, bestSnippet, passageScore, tokenize } from "./text.ts";
import { InProcessVectorIndex } from "./vector-index.ts";
import { type KnowledgeScope, UNFILED, entryInScope, knowledgeScope, scopeCollectionIds, visibleCollections } from "./visibility.ts";

/** What search needs from the store (the `KnowledgeStore` satisfies it). */
export type KnowledgeSearchStore = Pick<KnowledgeStorePort, "listMeta" | "getMeta" | "getEntry" | "onChange"> & {
  listCollections(): readonly KnowledgeCollection[];
  resolveCollection(ref: string): KnowledgeCollection | null;
};

export interface KnowledgeSearchOptions {
  store: KnowledgeSearchStore;
  graph: KnowledgeGraph;
  embedders: KnowledgeEmbedderSource;
  /** `knowledgeIndexDir(appdir)`: the disposable vector cache. */
  indexDir: string;
  logger?: KnowledgeLogger;
}

export const KNOWLEDGE_ENTRIES_DEFAULT_LIMIT = 50;
export const KNOWLEDGE_ENTRIES_MAX_LIMIT = 200;
export const KNOWLEDGE_QUERY_MAX = 1_000;
const RELATED_LIMIT = 8;
const CONCEPT_ENTRIES_LIMIT = 50;
/** Ids of a concept detail's visible entries (`KnowledgeConceptDetail.entryIds`), newest first. */
const CONCEPT_ENTRY_IDS_LIMIT = 2_000;
/** Candidates each signal list keeps. */
const CANDIDATES = 100;
const RRF_K = 60;
const WEIGHT = { keyword: 1, meaning: 1, similar: 1, expansion: 0.5, concept: 1 } as const;
/** MMR's trade-off between relevance and novelty. */
const MMR_LAMBDA = 0.7;
/** Hits that bring up the other side of a checked disagreement ({@link KnowledgeSearch.withOtherSides}). */
const OTHER_SIDE_WINDOW = 10;
/** How far down the ranked list another side is found (it matched the query). */
const OTHER_SIDE_REACH = 40;
/** The share of the query (its words by BM25 idf) a disagreement's note must hold for its other side to be brought up. */
const OTHER_SIDE_NOTED = 0.5;
/** Other sides one hit brings up. */
const OTHER_SIDE_MAX = 2;
/** A survey's share of its score when entries are ranked by relevance, unless the query asks for one. */
const SURVEY_RANK = 0.75;
/** Query tokens that ask for a survey: a map, an audit, an overview, a synthesis of the base. */
const SURVEY_QUERY_WORDS: ReadonlySet<string> = new Set(
  tokenize("map maps audit hub register index overview synthesis summary summaries contradiction contradictions playbook cross-links")
);
/** What holding every query token adds to a chunk's cosine when the passage to show is chosen ({@link queryPassage}). */
const PASSAGE_TERMS_WEIGHT = 0.1;
/** A query that asks for a duration ("how long to warm up a new TikTok account"). */
const DURATION_QUESTION = /\bhow\s+long\b/i;
/**
 * The words a duration is said in, searched by keyword beside the words of a query that asks how
 * long: "48 hours" holds no word of "how long to warm up a new TikTok account", while Erikas's "as
 * long as you have a new device" held the most.
 */
const DURATION_TERMS: readonly string[] = tokenize("hours days weeks");
/** A query that asks for a count ("how many TikTok accounts per phone"): "many" is the question, not a word to match. */
const COUNT_QUESTION = /\bhow\s+(?:many|much)\b/i;
/**
 * Words the entries use for one thing a query names in any of them: "how many TikTok accounts per
 * phone" is answered by "5 tiktok accounts on each iphone" and "2–3 TikTok accounts maximum per
 * device" ({@link KnowledgeSearch.termGroups}).
 */
const QUERY_SYNONYMS: readonly (readonly string[])[] = [tokenize("phone iphone device smartphone handset")];
/**
 * By relevance, a query that asks how long ranks an entry that states no duration beside its
 * subject ({@link KnowledgeSearch.answersDuration}) at this share of its score: on the live base "how
 * long to warm up a new TikTok account" put first Ema's "warm-up matters more than VPN", whose only
 * duration is when to check the account's country, above five posts that each state a warm-up length.
 */
const NO_DURATION_RANK = 0.8;
/** A query word on at most this share of the entries is part of what it asks about (its subject), not of every result's topic. */
const SUBJECT_MAX_SHARE = 0.15;
/** Recency half-life of the `recent` sort, in days. */
const RECENCY_HALF_LIFE_DAYS = 90;
/** Body words of an example entry its keyword fallback searches with (beside its title). */
const EXAMPLE_WORDS = 60;
/** Expansion seeds named in a hit's `match.concepts`. */
const MATCH_CONCEPTS = 3;
const SORTS: readonly KnowledgeSearchSort[] = ["relevance", "recent", "newest"];
const DAY_MS = 86_400_000;

/** One ranked entry of a search. */
interface Ranked {
  id: string;
  /** The RRF score. */
  fused: number;
  /** What it is ranked by: `fused`, boosted by recency for `recent`. */
  rank: number;
}

/** The decoded `nextCursor` of a search. */
interface SearchCursor {
  v: 1;
  /** Offset into the ranked entry list. */
  o: number;
  /** Fingerprint of the request and the caller's visibility. */
  h: string;
}

/**
 * Hybrid search and the read views over the knowledge base (spec "Querying", retrieval spec
 * "Search"):
 *
 * 1. embedding similarity over entry chunks (when the runtime is installed), through the
 *    {@link KnowledgeVectorIndex};
 * 2. BM25 over entries (title, body, author, handle) and concepts (name, aliases, attributes);
 * 3. a one-hop expansion through visible concepts;
 * 4. query by example (`similarTo` / `unlike`);
 *
 * fused with reciprocal-rank fusion, then sorted, diversified (MMR) and paged. Every step is
 * scoped by visibility and the request's filters while it ranks. A new entry is searchable (text,
 * and meaning once embedded) as soon as it is indexed, before linking. Without a runtime — or when
 * the model fails — search runs on BM25 and the graph alone.
 */
export class KnowledgeSearch {
  private readonly store: KnowledgeSearchStore;
  private readonly graph: KnowledgeGraph;
  private readonly logger: KnowledgeLogger;
  private readonly bodies = new Map<string, string>();
  private readonly bm25 = new Bm25Index();
  private readonly vectors: InProcessVectorIndex;
  private ready: Promise<void> | null = null;
  private textChain: Promise<unknown> = Promise.resolve();
  private readonly unsubscribers: (() => void)[] = [];
  /** `indexEntries` calls in flight, by their entries and versions. */
  private readonly indexing = new Map<string, Promise<void>>();
  /** Similar entries, possible duplicates, near-duplicates on save and the similarity graph. */
  readonly similarity: KnowledgeSimilarity;
  /** Contradictions, bridges, single-source concepts and link gaps (phase 2 spec, "Insights"). */
  readonly insights: KnowledgeInsights;
  /** What {@link connectLinking} wired in; `revision` moves whenever the pair checks change. */
  private linkingPorts: {
    pairChecks: KnowledgePairChecksPort | null;
    linkGapQueued: ((a: string, b: string) => boolean) | null;
    revision: number;
    unsubscribe: (() => void) | null;
  } = { pairChecks: null, linkGapQueued: null, revision: 0, unsubscribe: null };
  /** Neutral concept summaries (`concept-summaries.ts`); null: none ({@link connectConceptSummaries}). */
  private conceptSummaries: KnowledgeConceptSummariesPort | null = null;
  /** Concept families with their names and summaries; null: none ({@link connectConceptFamilies}). */
  private conceptFamilies: KnowledgeConceptFamilySummariesPort | null = null;

  constructor(options: KnowledgeSearchOptions) {
    this.store = options.store;
    this.graph = options.graph;
    this.logger = options.logger ?? console;
    this.vectors = new InProcessVectorIndex({
      embedders: options.embedders,
      indexDir: options.indexDir,
      logger: this.logger
    });
    this.similarity = new KnowledgeSimilarity({
      store: this.store,
      graph: this.graph,
      index: () => this.vectorIndex(),
      summary: (meta, scope) => this.summary(meta, scope),
      body: (id) => this.bodies.get(id) ?? null,
      naming: (phrase) => this.entriesNaming(phrase),
      pairChecks: () => this.linkingPorts.pairChecks,
      pairChecksRevision: () => this.linkingPorts.revision
    });
    this.insights = new KnowledgeInsights({
      store: this.store,
      graph: this.graph,
      similarity: this.similarity,
      index: () => this.vectorIndex(),
      summary: (meta, scope) => this.summary(meta, scope),
      stating: (claim) => this.entriesStating(claim),
      pairChecks: () => this.linkingPorts.pairChecks,
      pairChecksRevision: () => this.linkingPorts.revision,
      linkGapQueued: (a, b) => this.linkingPorts.linkGapQueued?.(a, b) ?? false
    });
  }

  /**
   * Connects linking's side of the phase 2 cross-graph views (spec "Shared seams"): its LLM pair
   * checks (contradictions in similar entries, the similarity graph and insights) and whether the
   * re-linker has queued both entries of a link gap (insights' `queued`). Until called, there are
   * no pair checks and no gap is queued. Calling again replaces both; `stop` disconnects.
   */
  connectLinking(ports: { pairChecks?: KnowledgePairChecksPort | null; linkGapQueued?: ((a: string, b: string) => boolean) | null }): void {
    this.linkingPorts.unsubscribe?.();
    const pairChecks = ports.pairChecks ?? null;
    this.linkingPorts = {
      pairChecks,
      linkGapQueued: ports.linkGapQueued ?? null,
      revision: this.linkingPorts.revision + 1,
      unsubscribe: null
    };
    const connected = this.linkingPorts;
    connected.unsubscribe = pairChecks?.onChange(() => {
      connected.revision += 1;
    }) ?? null;
  }

  /** Where concept details read their summaries from (null: none). */
  connectConceptSummaries(port: KnowledgeConceptSummariesPort | null): void {
    this.conceptSummaries = port;
  }

  /** Where concept details read their families from (`concept-family-summaries.ts`; null: none). */
  connectConceptFamilies(port: KnowledgeConceptFamilySummariesPort | null): void {
    this.conceptFamilies = port;
  }

  /** Subscribe to the store and index every entry's text (in the background; queries wait for it). */
  start(): Promise<void> {
    if (this.ready) return this.ready;
    this.unsubscribers.push(this.store.onChange((change) => this.onStoreChange(change)));
    this.vectors.start();
    this.ready = this.loadAll();
    return this.ready;
  }

  async stop(): Promise<void> {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.connectLinking({});
    await this.similarity.idle();
    const stopping = this.vectors.stop();
    await this.ready?.catch(() => undefined);
    await this.textChain.catch(() => undefined);
    await stopping;
  }

  /** Entries whose title or body names `phrase` (`mentions.ts` {@link namesPhrase}), read through the keyword index; unscoped. */
  entriesNaming(phrase: string): string[] {
    return this.bm25.keysWithAll(tokenize(phrase)).filter((id) => this.store.getMeta(id) !== null && namesPhrase(`${this.store.getMeta(id)!.title}\n${this.bodies.get(id) ?? ""}`, phrase));
  }

  /** Entries whose title or body states a claim's figure (`mentions.ts` {@link statesClaimNumber}), read through the keyword index; unscoped. */
  entriesStating(claim: string): string[] {
    const numbers = claimFigure(claim).numbers;
    if (numbers.length === 0) return [];
    return this.bm25
      .keysWithAll(numbers.flatMap((n) => tokenize(n)))
      .filter((id) => this.store.getMeta(id) !== null && statesClaimNumber(`${this.store.getMeta(id)!.title}\n${this.bodies.get(id) ?? ""}`, claim));
  }

  /** The vector index search, similarity and facets share (retrieval spec, "The vector index port"). */
  vectorIndex(): KnowledgeVectorIndex {
    return this.vectors;
  }

  /**
   * Index these entries now: text at once, embeddings first in the queue. Resolves when they are
   * searchable by text and — within the vector index's bounded save wait — by meaning; the rest is
   * embedded in the background.
   *
   * A call for the same entries at the same version as one still in flight shares it: a save's
   * route and the store's change listener both ask for the entries it added.
   */
  indexEntries(ids: readonly string[]): Promise<void> {
    const key = ids
      .map((id) => {
        const meta = this.store.getMeta(id);
        return `${id}:${meta?.contentHash ?? ""}:${meta?.updatedAt ?? ""}`;
      })
      .join(",");
    const running = this.indexing.get(key);
    if (running) return running;
    const run = this.indexEntriesNow(ids).finally(() => {
      if (this.indexing.get(key) === run) this.indexing.delete(key);
    });
    this.indexing.set(key, run);
    return run;
  }

  private async indexEntriesNow(ids: readonly string[]): Promise<void> {
    await this.whenReady();
    await this.serializeText(async () => {
      for (const id of ids) await this.indexText(id);
    });
    await this.vectors.embedForSave(ids);
  }

  /** Resolves once queued text indexing and embedding have finished (tests, shutdown). */
  /** Resolves once the entries are loaded and their vectors attached or embedded (linking waits on it). */
  async vectorsIdle(): Promise<void> {
    await this.whenReady();
    await this.vectors.idle();
  }

  async idle(): Promise<void> {
    await this.whenReady();
    await this.textChain.catch(() => undefined);
    await this.vectors.idle();
    await this.similarity.idle();
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  async search(request: KnowledgeSearchRequest, visibility: KnowledgeVisibility): Promise<KnowledgeSearchResponse> {
    // --- Validate ------------------------------------------------------------
    if (request.query !== undefined && request.query !== null && typeof request.query !== "string") {
      throw new KnowledgeError("KNOWLEDGE_INVALID", "The query must be text.");
    }
    const query = (request.query ?? "").trim();
    if (query.length > KNOWLEDGE_QUERY_MAX) throw new KnowledgeError("KNOWLEDGE_INVALID", `The query is longer than ${KNOWLEDGE_QUERY_MAX} characters.`);
    const similarTo = exampleIds(request.similarTo, "similarTo");
    const unlike = exampleIds(request.unlike, "unlike");
    if (query.length === 0 && similarTo.length === 0) {
      throw new KnowledgeError("KNOWLEDGE_INVALID", "The query is empty: send a query, or entry ids in similarTo.");
    }
    const filter = parseKnowledgeFilters(request.filters);
    const sort = request.sort ?? "relevance";
    if (!SORTS.includes(sort)) throw new KnowledgeError("KNOWLEDGE_INVALID", `sort must be one of ${SORTS.join(", ")}.`);
    const diverse = request.diverse !== false;
    const limit = clampLimit(request.limit, KNOWLEDGE_SEARCH_DEFAULT_LIMIT, KNOWLEDGE_SEARCH_MAX_LIMIT);
    const cursor = request.cursor !== undefined && request.cursor !== null ? decodeSearchCursor(request.cursor) : null;
    // "unfiled" narrows to entries with no collection, for callers who see everything (as in the entries and graph routes).
    const narrow = request.collections && request.collections.length > 0 ? this.resolveVisible(request.collections, visibility, true) : null;
    await this.whenReady();
    const collections = this.store.listCollections();
    const known = collections.map((c) => c.id);
    const scope = knowledgeScope(visibility, known, narrow);
    const searched = scopeCollectionIds(scope, known);
    // Examples must be visible to the caller (the narrowing does not hide them); a hidden one is refused like an unknown one.
    const visibleScope = narrow ? knowledgeScope(visibility, known) : scope;
    for (const id of [...similarTo, ...unlike]) {
      const meta = this.store.getMeta(id);
      if (!meta || !entryInScope(meta, visibleScope)) throw new KnowledgeError("KNOWLEDGE_NOT_FOUND", `No visible entry "${id.slice(0, 80)}".`);
    }
    const fingerprint = searchFingerprint({ query, narrow, filter, similarTo, unlike, sort, diverse, visibility });
    if (cursor && cursor.h !== fingerprint) {
      throw new KnowledgeError("KNOWLEDGE_INVALID", "The cursor belongs to another search: send the same request with it, or drop the cursor.");
    }

    // --- One predicate for visibility, filters and the examples -------------
    const excluded = new Set([...similarTo, ...unlike]);
    const accepted = new Map<string, boolean>();
    const accept = (id: string): boolean => {
      let ok = accepted.get(id);
      if (ok === undefined) {
        const meta = excluded.has(id) ? null : this.store.getMeta(id);
        ok = meta !== null && entryInScope(meta, scope) && entryMatchesFilter(meta, filter);
        accepted.set(id, ok);
      }
      return ok;
    };

    // --- Signals ------------------------------------------------------------
    this.vectors.backfill();
    const thresholds = this.vectors.thresholds();
    // "How long …" asks for a duration: "long" is the question, not a word to match ("as long as"); a
    // duration is said in hours, days or weeks, which the keyword signal searches beside the query's words.
    const duration = DURATION_QUESTION.test(query);
    // "How many …" asks for a count: "many" (or "much") is the question, a stated number the answer.
    const count = !duration && COUNT_QUESTION.test(query);
    const shape: AnswerShape = duration ? "duration" : count ? "count" : null;
    const question = (token: string): boolean => (duration && token === "long") || (count && (token === "many" || token === "much"));
    const terms = tokenize(query).filter((token) => !question(token));
    // Each word with its forms and synonyms in the entries ("warm" / "warming", "phone" / "iphone").
    const groups = this.termGroups(terms);
    const keyword = query ? this.bm25.search(duration ? [...groups, ...DURATION_TERMS] : groups, accept, CANDIDATES).map((hit) => hit.key) : [];
    const meaningHits = query ? await this.meaningSearch(query, accept) : [];
    const meaningById = new Map(meaningHits.map((hit) => [hit.entryId, hit]));
    const meaning = meaningHits.map((hit) => hit.entryId);
    const similarHits = similarTo.length > 0 ? this.exampleSearch(similarTo, unlike, accept) : { ids: [], hits: new Map<string, KnowledgeVectorHit>() };
    const similar = similarHits.ids;

    // One hop through visible concepts: the best concepts, and the concepts of the best entries.
    const conceptMatches = query ? this.graph.searchConcepts(terms, scope, CANDIDATES) : [];
    const conceptHits = conceptMatches.map((hit) => hit.id);
    const expansionSeeds = new Map<string, string[]>();
    let expansion: string[] = [];
    if (query) {
      const preliminary = fuse([
        [keyword, WEIGHT.keyword],
        [meaning, WEIGHT.meaning],
        [similar, WEIGHT.similar]
      ]);
      const seeds = [...conceptHits.slice(0, 5)];
      for (const [entryId] of [...preliminary].slice(0, 3)) {
        for (const conceptId of this.graph.conceptIdsOfEntry(entryId)) if (!seeds.includes(conceptId)) seeds.push(conceptId);
      }
      const expansionScores = new Map<string, number>();
      seeds.forEach((conceptId, rank) => {
        for (const entryId of this.graph.visibleEntriesOf(conceptId, scope)) {
          if (!accept(entryId)) continue;
          expansionScores.set(entryId, (expansionScores.get(entryId) ?? 0) + 1 / (1 + rank));
          const via = expansionSeeds.get(entryId) ?? [];
          if (via.length < MATCH_CONCEPTS) via.push(conceptId);
          expansionSeeds.set(entryId, via);
        }
      });
      expansion = [...expansionScores]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, CANDIDATES)
        .map(([id]) => id);
    }

    // --- Fuse, sort, diversify ------------------------------------------------
    const entryScores = fuse([
      [keyword, WEIGHT.keyword],
      [meaning, WEIGHT.meaning],
      [similar, WEIGHT.similar],
      [expansion, WEIGHT.expansion]
    ]);
    /** The best possible entry score (first in every list that ran), so scores land in 0..1. */
    const scale = ((query ? WEIGHT.keyword + WEIGHT.meaning + WEIGHT.expansion : 0) + (similarTo.length > 0 ? WEIGHT.similar : 0)) / (RRF_K + 1);
    const normalized = (score: number) => Math.min(1, Math.round((score / scale) * 1e4) / 1e4);
    const ranked = sort === "newest" ? this.rank(entryScores, sort, diverse) : this.withOtherSides(this.rank(entryScores, sort, diverse, terms, duration ? groups : null), scope, groups);

    // --- Concept hits (first page only) ---------------------------------------
    // A concept is one ranked list, an entry the sum of up to four: their fused scores are not on one
    // scale, and a concept would never outrank an entry found by two signals (the top concept fuses
    // to 1/61, the top entry to up to 2.5/61). A concept hit's score is its own list's, normalized
    // like an entry's (1 for the first), times the share of the query its name or aliases hold: the
    // concept named like the query scores near 1 and is listed among the best entries; one matched
    // in its description only scores 0 and comes after them. The best scores are listed.
    const maxConcepts = Math.max(1, Math.floor(limit / 3));
    const offset = cursor?.o ?? 0;
    const conceptItems: { id: string; score: number; entryIds: string[] }[] = [];
    if (!cursor) {
      const conceptScale = WEIGHT.concept / (RRF_K + 1);
      const scored = conceptMatches
        .map((hit, rank) => ({ id: hit.id, rank, score: Math.round((WEIGHT.concept / (RRF_K + rank + 1) / conceptScale) * hit.named * 1e4) / 1e4 }))
        .sort((a, b) => b.score - a.score || a.rank - b.rank);
      for (const { id, score } of scored) {
        if (conceptItems.length >= maxConcepts) break;
        const entryIds = this.graph
          .visibleEntriesOf(id, scope)
          .filter(accept)
          .map((entryId) => ({ id: entryId, score: entryScores.get(entryId) ?? 0, savedAt: this.store.getMeta(entryId)?.savedAt ?? "" }))
          .sort((a, b) => b.score - a.score || b.savedAt.localeCompare(a.savedAt) || (a.id < b.id ? -1 : 1))
          .slice(0, 3)
          .map((e) => e.id);
        // With filters, a concept whose visible entries all fail them is not a hit.
        if (entryIds.length > 0 && this.graph.conceptRef(id, scope)) conceptItems.push({ id, score, entryIds });
      }
    }

    // --- Page -------------------------------------------------------------------
    const signals = {
      groups,
      words: queryWords(query).filter((word) => !word.tokens.every(question)),
      shape,
      keyword: new Set(keyword),
      meaning: meaningById,
      similar: similarHits.hits,
      similarIds: new Set(similar),
      expansion: new Set(expansion),
      expansionSeeds,
      thresholds
    };
    const hits: KnowledgeSearchHit[] = [];
    let next = offset;
    let c = 0;
    while (hits.length < limit && (next < ranked.length || c < conceptItems.length)) {
      const entry = ranked[next];
      const concept = conceptItems[c];
      if (concept && (!entry || concept.score > normalized(entry.fused))) {
        c += 1;
        const ref = this.graph.conceptRef(concept.id, scope)!;
        hits.push({
          kind: "concept",
          score: concept.score,
          concept: ref,
          entryIds: concept.entryIds,
          entries: concept.entryIds.map((id) => ({ id, title: this.store.getMeta(id)?.title ?? id }))
        });
        continue;
      }
      next += 1;
      const meta = entry ? this.store.getMeta(entry.id) : null;
      if (!entry || !meta) continue;
      hits.push(this.entryHit(meta, scope, normalized(entry.fused), signals));
    }
    const response: KnowledgeSearchResponse = {
      hits,
      searched,
      total: ranked.length,
      nextCursor: next < ranked.length ? encodeSearchCursor({ v: 1, o: next, h: fingerprint }) : null
    };
    if (request.facets === true) {
      const metas = ranked.map((r) => this.store.getMeta(r.id)).filter((m): m is KnowledgeEntryMeta => m !== null);
      response.facets = computeKnowledgeFacets(metas, scope, collections);
    }
    return response;
  }

  private async meaningSearch(query: string, accept: (id: string) => boolean): Promise<KnowledgeVectorHit[]> {
    const vector = await this.vectors.embedQuery(query);
    return vector ? this.vectors.search(vector, accept, CANDIDATES) : [];
  }

  /**
   * Query by example: the entries nearest mean(similarTo) of the examples' entry vectors (at or above
   * the model's `minimum`); with `unlike`, an entry closer to mean(unlike) than to the examples drops
   * by the difference. BM25 over the examples' titles and openings when none has vectors.
   *
   * `unlike` steers the order, not the target: a sentence model puts every text in a narrow cone
   * (multilingual-e5 scores any two entries 0.73–0.99), so subtracting a vector removes much of what
   * all entries share and would leave nothing above `minimum`. Both similarities are rescaled from
   * [minimum, 1] to [0, 1] first, which spreads that narrow band out. Only the excess counts, so
   * entries on the examples' topic that merely share it with the unlike entry keep their place.
   */
  private exampleSearch(
    similarTo: readonly string[],
    unlike: readonly string[],
    accept: (id: string) => boolean
  ): { ids: string[]; hits: Map<string, KnowledgeVectorHit> } {
    const like = similarTo.map((id) => this.vectors.entryVector(id)).filter((v): v is Float32Array => v !== null);
    const target = like.length > 0 ? meanOf(like) : null;
    if (target && normalize(target)) {
      const away = unlike.map((id) => this.vectors.entryVector(id)).filter((v): v is Float32Array => v !== null);
      const awayTarget = away.length > 0 ? meanOf(away) : null;
      const thresholds = this.vectors.thresholds();
      if (!awayTarget || !normalize(awayTarget) || !thresholds) {
        const hits = this.vectors.search(target, accept, CANDIDATES);
        return { ids: hits.map((hit) => hit.entryId), hits: new Map(hits.map((hit) => [hit.entryId, hit])) };
      }
      const floor = thresholds.minimum;
      const spread = (similarity: number) => Math.max(0, (similarity - floor) / Math.max(1e-6, 1 - floor));
      const steered = this.vectors
        .search(target, accept, KNOWLEDGE_SEARCH_MAX_RESULTS)
        .map((hit) => {
          const vector = this.vectors.entryVector(hit.entryId);
          const awaySimilarity = vector ? dotOf(vector, awayTarget) : floor;
          const near = spread(hit.score);
          return { hit, order: near - Math.max(0, spread(awaySimilarity) - near) };
        })
        .sort((a, b) => b.order - a.order || b.hit.score - a.hit.score || (a.hit.entryId < b.hit.entryId ? -1 : 1))
        .slice(0, CANDIDATES)
        .map(({ hit }) => hit);
      return { ids: steered.map((hit) => hit.entryId), hits: new Map(steered.map((hit) => [hit.entryId, hit])) };
    }
    const exampleTerms: string[] = [];
    for (const id of similarTo) {
      const meta = this.store.getMeta(id);
      const body = this.bodies.get(id) ?? "";
      exampleTerms.push(...tokenize(meta?.title ?? ""), ...tokenize(firstWords(body, EXAMPLE_WORDS)));
    }
    return { ids: this.bm25.search(exampleTerms, accept, CANDIDATES).map((hit) => hit.key), hits: new Map() };
  }

  /**
   * Both sides of a disagreement the query finds: each of the first {@link OTHER_SIDE_WINDOW} hits
   * (by its own place, whether or not another hit brought it up) that an LLM pair check found to
   * contradict an entry further down (within {@link OTHER_SIDE_REACH} places: the query found it
   * too), with a note about the query ({@link OTHER_SIDE_NOTED} of its words by idf), brings it up
   * to just after itself, at most {@link OTHER_SIDE_MAX} of them: those whose note
   * is most about the query first (its query words, by their BM25 idf), then those that would
   * otherwise fall past the window, then the higher placed. A side brought up from past the window
   * brings no other. The same results always come in the same order, so pages stay stable.
   *
   * Before, a hit another hit brought up brought none of its own, and a hit already placed was
   * skipped: on the live base "VPN or proxy for a US TikTok account" placed jason first, who brought
   * up daniel (#2) and Alex (#3), so neither brought up Ema's NordVPN post (daniel's checked
   * disagreement, #9) or Ema's "VPN matters less" (Alex's, #7).
   */
  private withOtherSides(ranked: readonly Ranked[], scope: KnowledgeScope, groups: readonly (readonly string[])[]): Ranked[] {
    const checks = this.linkingPorts.pairChecks;
    if (!checks || ranked.length < 2) return [...ranked];
    const place = new Map(ranked.slice(0, OTHER_SIDE_REACH).map((item, at) => [item.id, at]));
    const found = findContradictions({ graph: this.graph, scope, pairChecks: checks, accept: (id) => place.has(id), entryMeta: (id) => this.store.getMeta(id) });
    const sides = new Map<string, { id: string; at: number; noted: number }[]>();
    // A query word counts once, by its own idf, whichever of its forms or synonyms a note holds.
    const whole = groups.reduce((sum, group) => sum + this.bm25.idf(group[0]!), 0);
    for (const { a, b, source, note } of found.values()) {
      if (source !== "checked" || note === null) continue;
      // How much of the query the note is about: its query words, rare ones weighing more. A
      // disagreement about the query holds at least half of it ({@link OTHER_SIDE_NOTED}); one whose
      // note holds only the words every result has ("TikTok account") is about something else
      // (daniel's VPN disagreements, for "how long to warm up a new TikTok account"): its other side
      // stays where the query put it.
      const said = new Set(tokenize(note));
      const noted = groups.reduce((sum, group) => sum + (group.some((token) => said.has(token)) ? this.bm25.idf(group[0]!) : 0), 0);
      if (noted <= 0 || noted < OTHER_SIDE_NOTED * whole) continue;
      for (const [x, y] of [
        [a, b],
        [b, a]
      ] as const) {
        let list = sides.get(x);
        if (!list) sides.set(x, (list = []));
        list.push({ id: y, at: place.get(y)!, noted });
      }
    }
    if (sides.size === 0) return [...ranked];
    const out: Ranked[] = [];
    const placed = new Set<string>();
    const byId = new Map(ranked.map((item) => [item.id, item]));
    const emit = (item: Ranked): void => {
      out.push(item);
      placed.add(item.id);
      const at = place.get(item.id);
      if (at === undefined || at >= OTHER_SIDE_WINDOW) return;
      const others = (sides.get(item.id) ?? [])
        .filter((side) => !placed.has(side.id) && side.at > at)
        .sort((x, y) => y.noted - x.noted || Number(x.at < OTHER_SIDE_WINDOW) - Number(y.at < OTHER_SIDE_WINDOW) || x.at - y.at)
        .slice(0, OTHER_SIDE_MAX);
      for (const side of others) if (!placed.has(side.id)) emit(byId.get(side.id)!);
    };
    for (const item of ranked) if (!placed.has(item.id)) emit(item);
    return out;
  }

  /**
   * Each query token with the forms of it the entries hold ("warm" / "warming" / "warmed", "use" /
   * "using") and its synonyms there ({@link QUERY_SYNONYMS}); the token itself first. A group
   * matches as one word: BM25 scores the best of its terms, a passage holds it once.
   */
  termGroups(terms: readonly string[]): string[][] {
    return [...new Set(terms)].map((term) => {
      const out = new Set([term]);
      for (const form of termForms(term)) if (this.bm25.has(form)) out.add(form);
      for (const group of QUERY_SYNONYMS) if (group.includes(term)) for (const other of group) if (this.bm25.has(other)) out.add(other);
      return [...out];
    });
  }

  /**
   * What a query asks about, of its word groups: those whose word is on at most
   * {@link SUBJECT_MAX_SHARE} of the entries ("warm" in "how long to warm up a new TikTok account",
   * not "tiktok" or "account"), else the rarest one.
   */
  private subjectOf(groups: readonly (readonly string[])[]): (readonly string[])[] {
    if (groups.length === 0) return [];
    const most = SUBJECT_MAX_SHARE * this.bm25.size();
    const rare = groups.filter((group) => this.bm25.documentFrequency(group[0]!) <= most);
    if (rare.length > 0) return rare;
    return [groups.reduce((x, y) => (this.bm25.idf(y[0]!) > this.bm25.idf(x[0]!) ? y : x))];
  }

  /**
   * Whether an entry states a duration in a clause (a sentence, a line, a part between semicolons)
   * of its title or body that holds a word of the query's subject: "3-5 days of warming up", "warm
   * it up for 48 hours", not "check account country after 60 days".
   */
  private answersDuration(id: string, subject: readonly (readonly string[])[]): boolean {
    const text = `${this.store.getMeta(id)?.title ?? ""}\n${this.bodies.get(id) ?? ""}`;
    for (const match of text.matchAll(DURATIONS)) {
      let start = match.index;
      while (start > 0 && !clauseEndsAt(text, start - 1)) start -= 1;
      let end = match.index + match[0].length;
      while (end < text.length && !clauseEndsAt(text, end)) end += 1;
      const clause = new Set(tokenize(text.slice(start, end)));
      if (subject.some((group) => group.some((token) => clause.has(token)))) return true;
    }
    return false;
  }

  /**
   * The ranked entry list (≤ KNOWLEDGE_SEARCH_MAX_RESULTS): sorted, then spread apart by MMR. By
   * relevance a survey ({@link isSurveyEntry}) ranks at {@link SURVEY_RANK} of its score unless the
   * query asks for one ({@link SURVEY_QUERY_WORDS}): it restates what the entries it surveys say,
   * so it matches most queries on their topic, with a passage about something else. A query that
   * asks how long (`durationOf`: its word groups) ranks an entry stating no duration beside its
   * subject at {@link NO_DURATION_RANK} of its score.
   */
  private rank(
    entryScores: ReadonlyMap<string, number>,
    sort: KnowledgeSearchSort,
    diverse: boolean,
    terms: readonly string[] = [],
    durationOf: readonly (readonly string[])[] | null = null
  ): Ranked[] {
    if (sort === "newest") {
      const dated: (Ranked & { savedAt: string })[] = [];
      for (const [id, fused] of entryScores) {
        const meta = this.store.getMeta(id);
        if (meta) dated.push({ id, fused, rank: fused, savedAt: meta.savedAt });
      }
      return dated
        .sort(newestFirst)
        .slice(0, KNOWLEDGE_SEARCH_MAX_RESULTS)
        .map(({ id, fused, rank }) => ({ id, fused, rank }));
    }
    const now = Date.now();
    const ranked: Ranked[] = [];
    const surveysWanted = terms.some((term) => SURVEY_QUERY_WORDS.has(term));
    const subject = durationOf ? this.subjectOf(durationOf) : [];
    const surveyRank = (id: string): number =>
      (!surveysWanted && isSurveyEntry(this.store.getMeta(id)) ? SURVEY_RANK : 1) * (subject.length > 0 && !this.answersDuration(id, subject) ? NO_DURATION_RANK : 1);
    for (const [id, fused] of entryScores) {
      if (sort === "recent") {
        const meta = this.store.getMeta(id);
        if (!meta) continue;
        ranked.push({ id, fused, rank: fused * recencyFactor(meta, now) * surveyRank(id) });
      } else {
        ranked.push({ id, fused, rank: fused * surveyRank(id) });
      }
    }
    ranked.sort((a, b) => b.rank - a.rank || (a.id < b.id ? -1 : 1));
    const capped = ranked.slice(0, KNOWLEDGE_SEARCH_MAX_RESULTS);
    return diverse ? mmr(capped, (id) => this.vectors.entryVector(id)) : capped;
  }

  private entryHit(
    meta: KnowledgeEntryMeta,
    scope: KnowledgeScope,
    score: number,
    signals: {
      /** The query's words, each with its forms and synonyms in the entries. */
      groups: readonly (readonly string[])[];
      words: { word: string; tokens: string[] }[];
      keyword: ReadonlySet<string>;
      meaning: ReadonlyMap<string, KnowledgeVectorHit>;
      similar: ReadonlyMap<string, KnowledgeVectorHit>;
      similarIds: ReadonlySet<string>;
      expansion: ReadonlySet<string>;
      expansionSeeds: ReadonlyMap<string, string[]>;
      thresholds: KnowledgeVectorThresholds | null;
      /** The query asks how long or how many: a passage stating a duration, or a number, is preferred. */
      shape: AnswerShape;
    }
  ): KnowledgeSearchHit {
    const id = meta.id;
    const meaningHit = signals.meaning.get(id);
    const similarHit = signals.similar.get(id);
    const via: KnowledgeMatchSignal[] = [];
    if (signals.keyword.has(id)) via.push("keyword");
    if (meaningHit) via.push("meaning");
    if (signals.similarIds.has(id)) via.push("similar");
    if (signals.expansion.has(id)) via.push("concept");
    const holds = (group: readonly string[]): boolean => group.some((token) => this.bm25.contains(id, token));
    const groupOf = new Map(signals.groups.map((group) => [group[0]!, group]));
    const terms = signals.words.filter((w) => w.tokens.every((token) => holds(groupOf.get(token) ?? [token]))).map((w) => w.word);
    const coverage = signals.groups.length > 0 ? signals.groups.filter(holds).length / signals.groups.length : 0;
    const similarity = Math.max(meaningHit?.score ?? -Infinity, similarHit?.score ?? -Infinity);
    const body = this.bodies.get(id) ?? "";
    const passage = meaningHit ? queryPassage(meaningHit, body, signals.groups, signals.shape) : null;
    const match: KnowledgeEntryMatch = {
      band: matchBand(Number.isFinite(similarity) ? similarity : null, coverage, via, signals.thresholds),
      via,
      terms,
      passage: passage ? { start: passage.span.start, end: passage.span.end, chunk: passage.chunk, chunks: meaningHit!.chunks } : null,
      concepts: (signals.expansionSeeds.get(id) ?? [])
        .map((conceptId) => this.graph.conceptRef(conceptId, scope))
        .filter((ref): ref is NonNullable<typeof ref> => ref !== null)
        .map(({ id: conceptId, name, type }): KnowledgeConceptRef => ({ id: conceptId, name, type }))
    };
    const span: TextSpan | undefined = passage?.span ?? similarHit?.span;
    const snippet = bestSnippet(body, signals.groups, span, signals.shape);
    return { kind: "entry", score, entry: this.summary(meta, scope, snippet), match };
  }

  // -------------------------------------------------------------------------
  // Read views
  // -------------------------------------------------------------------------

  /** The scope of a request, given its (already resolved) narrowing. */
  scope(visibility: KnowledgeVisibility, narrow?: readonly string[] | null): KnowledgeScope {
    return knowledgeScope(
      visibility,
      this.store.listCollections().map((c) => c.id),
      narrow
    );
  }

  summary(meta: KnowledgeEntryMeta, scope: KnowledgeScope, snippet?: string): KnowledgeEntrySummary {
    return {
      ...meta,
      savedFrom: { ...meta.savedFrom },
      collections: visibleCollections(meta, scope),
      snippet: snippet ?? bestSnippet(this.bodies.get(meta.id) ?? "", []),
      linkCount: this.graph.linkCount(meta.id),
      citation: knowledgeCitation(meta)
    };
  }

  /**
   * Newest first; `collection` is an id, `unfiled`, or absent. The filter params (comma-separated
   * lists, ISO bounds) mean what they mean in search.
   */
  async listEntries(query: KnowledgeEntriesQuery, visibility: KnowledgeVisibility): Promise<KnowledgeEntriesResponse> {
    const filter = parseKnowledgeFilters({
      kinds: splitFilterList(query.kinds, "kinds"),
      authors: splitFilterList(query.authors, "authors"),
      years: splitFilterList(query.years, "years"),
      postedAfter: query.postedAfter,
      postedBefore: query.postedBefore,
      savedAfter: query.savedAfter,
      savedBefore: query.savedBefore
    });
    await this.whenReady();
    const limit = clampLimit(query.limit, KNOWLEDGE_ENTRIES_DEFAULT_LIMIT, KNOWLEDGE_ENTRIES_MAX_LIMIT);
    const narrow = query.collection ? this.resolveVisible([query.collection], visibility, true) : null;
    const scope = this.scope(visibility, narrow);
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    const matching = this.store
      .listMeta()
      .filter((meta) => entryInScope(meta, scope) && entryMatchesFilter(meta, filter));
    // The cursor is independent of ordering: discard earlier pages before sorting
    // the remaining entries, and skip the no-op cursor pass on the first page.
    const metas = (after ? matching.filter((meta) => newestFirst(meta, after) > 0) : matching).sort(newestFirst);
    const page = metas.slice(0, limit);
    const last = page[page.length - 1];
    return {
      entries: page.map((meta) => this.summary(meta, scope)),
      nextCursor: metas.length > limit && last ? encodeCursor(last) : null
    };
  }

  /**
   * A visible entry with its concepts, related and similar entries and possible duplicates; null
   * when hidden or unknown. `evenIfHidden`: the entry itself is answered even when out of scope (a
   * caller's own edit that moved it out of view); its collections, related and similar entries are
   * still only the visible ones.
   */
  async entryDetail(id: string, visibility: KnowledgeVisibility, options: { evenIfHidden?: boolean } = {}): Promise<KnowledgeEntryDetail | null> {
    await this.whenReady();
    const scope = this.scope(visibility);
    const meta = this.store.getMeta(id);
    if (!meta || (!options.evenIfHidden && !entryInScope(meta, scope))) return null;
    const entry = await this.store.getEntry(id);
    if (!entry) return null;
    const related = this.graph
      .relatedEntries(id, scope, RELATED_LIMIT)
      .map((r) => this.store.getMeta(r.id))
      .filter((m): m is KnowledgeEntryMeta => m !== null)
      .map((m) => this.summary(m, scope));
    const { similar, possibleDuplicates, disagreements, disagreementsTotal } = this.similarity.forEntry(id, scope);
    const novelty = this.similarity.novelty(id, scope);
    return {
      entry: { ...entry, savedFrom: { ...entry.savedFrom }, collections: visibleCollections(entry, scope) },
      concepts: this.graph.conceptsOfEntry(id, scope),
      related,
      similar,
      possibleDuplicates,
      ...(novelty ? { novelty } : {}),
      disagreements,
      ...(disagreementsTotal > disagreements.length ? { disagreementsTotal } : {}),
      citation: knowledgeCitation(meta)
    };
  }

  /** An entry (`ke_…`) or concept id; null when hidden or unknown. */
  async item(id: string, visibility: KnowledgeVisibility): Promise<KnowledgeItemResponse | null> {
    if (isKnowledgeEntryId(id)) {
      const entry = await this.entryDetail(id, visibility);
      return entry ? { kind: "entry", entry } : null;
    }
    const concept = await this.conceptDetail(id, visibility);
    return concept ? { kind: "concept", concept } : null;
  }

  async conceptDetail(id: string, visibility: KnowledgeVisibility): Promise<KnowledgeConceptDetail | null> {
    await this.whenReady();
    const scope = this.scope(visibility);
    const view = this.graph.concept(id, scope);
    if (!view) return null;
    // Every visible entry behind it (a merged concept's: those of its visible sources), newest first;
    // a Person's own entries (by author or handle) before those that cite or discuss them.
    const sorted = view.entryIds
      .map((entryId) => this.store.getMeta(entryId))
      .filter((m): m is KnowledgeEntryMeta => m !== null)
      .sort(newestFirst);
    const authored = this.graph.personAuthorship(view.concept.id);
    const newest = authored ? [...sorted.filter((m) => authored(m)), ...sorted.filter((m) => !authored(m))] : sorted;
    // Served only to a caller who can see every entry it was written from (`concept-summaries.ts`).
    const visible = (entryId: string): KnowledgeEntryMeta | null => {
      const meta = this.store.getMeta(entryId);
      return meta && entryInScope(meta, scope) ? meta : null;
    };
    const canonical = this.graph.canonicalConceptId(id);
    const summary = this.conceptSummaries?.summaryFor(canonical, { visible, behind: new Set(view.entryIds) });
    // Its visible family members; the name and summary as concept summaries (`concept-family-summaries.ts`).
    const family = this.conceptFamilies?.familyFor(canonical, {
      concept: (conceptId) => {
        const ref = this.graph.conceptRef(conceptId, scope);
        return ref ? { id: ref.id, name: ref.name, type: ref.type } : null;
      },
      visible,
      behind: (conceptId) => this.graph.visibleEntriesOf(conceptId, scope)
    });
    return {
      concept: view.concept,
      collections: view.collections,
      entries: newest.slice(0, CONCEPT_ENTRIES_LIMIT).map((m) => this.summary(m, scope)),
      neighbors: view.neighbors,
      mergedFrom: view.mergedFrom,
      similarConcepts: view.similarConcepts,
      entryIds: newest.slice(0, CONCEPT_ENTRY_IDS_LIMIT).map((m) => m.id),
      ...(summary ? { summary } : {}),
      ...(family ? { family } : {})
    };
  }

  /** `collections` is the contract's comma-separated list of ids (or `unfiled`). */
  graphView(
    query: { collections?: string; focus?: string; depth?: number; limit?: number },
    visibility: KnowledgeVisibility
  ): KnowledgeGraphResponse {
    const refs = (query.collections ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const narrow = refs.length > 0 ? this.resolveVisible(refs, visibility, true) : null;
    const scope = this.scope(visibility, narrow);
    const result = this.graph.graph(scope, {
      focus: query.focus,
      depth: query.depth,
      limit: query.limit === undefined ? KNOWLEDGE_GRAPH_MAX_NODES : query.limit
    });
    if (!result) throw new KnowledgeError("KNOWLEDGE_NOT_FOUND", "Nothing visible has that id.");
    return result;
  }

  /**
   * Collection ids for refs (ids or exact names) the caller can see. A hidden collection is
   * refused like an unknown one, and the message lists only what the caller can see.
   */
  resolveVisible(refs: readonly string[], visibility: KnowledgeVisibility, allowUnfiled: boolean): string[] {
    const visibleIds = visibility.kind === "all" ? null : new Set(visibility.ids);
    const out: string[] = [];
    for (const ref of refs) {
      if (allowUnfiled && ref.trim().toLowerCase() === UNFILED) {
        if (visibility.kind === "all") {
          if (!out.includes(UNFILED)) out.push(UNFILED);
          continue;
        }
      } else {
        const collection = this.store.resolveCollection(ref);
        if (collection && (!visibleIds || visibleIds.has(collection.id))) {
          if (!out.includes(collection.id)) out.push(collection.id);
          continue;
        }
      }
      const names = this.store
        .listCollections()
        .filter((c) => !visibleIds || visibleIds.has(c.id))
        .map((c) => `"${c.name}"`);
      throw new KnowledgeError(
        "KNOWLEDGE_UNKNOWN_COLLECTION",
        `No collection "${ref.slice(0, 80)}" here. ${names.length > 0 ? `Collections: ${names.join(", ")}.` : "No collections are visible."}`
      );
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Indexing
  // -------------------------------------------------------------------------

  private whenReady(): Promise<void> {
    return this.ready ?? this.start();
  }

  private onStoreChange(change: KnowledgeEntryChange): void {
    // Visibility and filters read collections from the store live, and collections are not embedded.
    if (change.kind === "relabelled") return;
    if (change.kind === "deleted") {
      void this.whenReady().then(() =>
        this.serializeText(async () => {
          for (const id of change.entryIds) this.removeDoc(id);
          await this.vectors.retain();
        })
      );
      return;
    }
    this.indexEntries(change.entryIds).catch((error: Error) => this.logger.warn(`knowledge: indexing failed (${error.message})`));
  }

  private serializeText<T>(task: () => Promise<T>): Promise<T> {
    const run = this.textChain.then(task, task);
    this.textChain = run.catch(() => undefined);
    return run;
  }

  private async loadAll(): Promise<void> {
    const metas = [...this.store.listMeta()];
    const workers = Array.from({ length: Math.min(16, metas.length) }, async (_, worker) => {
      for (let i = worker; i < metas.length; i += 16) {
        await this.indexText(metas[i]!.id).catch((error: Error) =>
          this.logger.warn(`knowledge: could not index entry ${metas[i]!.id} (${error.message})`)
        );
      }
    });
    await Promise.all(workers);
    // Attach cached vectors now; the rest are embedded in the background (and again for each new model).
    await this.vectors.backfillAll();
  }

  private async indexText(id: string): Promise<void> {
    const meta = this.store.getMeta(id);
    const entry = meta ? await this.store.getEntry(id) : null;
    if (!meta || !entry) {
      this.removeDoc(id);
      return;
    }
    this.bodies.set(id, entry.body);
    // The vector index keys its cache on the text it embeds (header and body), never on the hash
    // the metadata claims: a hand-edited file must not file vectors under another body.
    this.vectors.setEntry(id, entry);
    this.bm25.add(id, [
      { tokens: tokenize(entry.title), weight: 3 },
      { tokens: tokenize(entry.body), weight: 1 },
      { tokens: tokenize([entry.author ?? "", entry.handle ?? ""].join(" ")), weight: 2 }
    ]);
  }

  private removeDoc(id: string): void {
    this.bodies.delete(id);
    this.bm25.remove(id);
    this.vectors.removeEntry(id);
  }
}

// ---------------------------------------------------------------------------
// Ranking helpers
// ---------------------------------------------------------------------------

/** Reciprocal-rank fusion: Σ weight / (k + rank), rank from 1. Insertion order is best first. */
function fuse(lists: readonly (readonly [readonly string[], number])[]): Map<string, number> {
  const scores = new Map<string, number>();
  for (const [list, weight] of lists) {
    list.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + weight / (RRF_K + index + 1)));
  }
  return new Map([...scores].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
}

/** The `recent` sort's boost: 0.5 + 0.5 · 2^(−ageDays/90), age from `postedAt`, else `savedAt`. */
function recencyFactor(meta: Pick<KnowledgeEntryMeta, "postedAt" | "savedAt">, now: number): number {
  let at = Date.parse(meta.postedAt ?? meta.savedAt);
  if (Number.isNaN(at)) at = Date.parse(meta.savedAt);
  if (Number.isNaN(at)) return 0.5;
  const ageDays = Math.max(0, (now - at) / DAY_MS);
  return 0.5 + 0.5 * 2 ** (-ageDays / RECENCY_HALF_LIFE_DAYS);
}

/**
 * Maximal marginal relevance over a ranked list (best first): greedily pick the entry maximizing
 * λ·rel − (1−λ)·max cosine to those already picked, rel = rank / best rank. An entry without a
 * vector has similarity 0 to everything. Deterministic: ties keep the ranked order.
 */
function mmr<T extends { id: string; rank: number }>(ranked: readonly T[], vectorOf: (id: string) => Float32Array | null): T[] {
  const n = ranked.length;
  if (n <= 2) return [...ranked];
  const best = ranked[0]!.rank;
  const rel = ranked.map((r) => (best > 0 ? r.rank / best : 0));
  const vectors = ranked.map((r) => vectorOf(r.id));
  const maxSim = new Float64Array(n).fill(-Infinity);
  const taken = new Uint8Array(n);
  const out: T[] = [];
  let last = -1;
  for (let step = 0; step < n; step += 1) {
    if (last >= 0) {
      const lv = vectors[last];
      for (let i = 0; i < n; i += 1) {
        if (taken[i]) continue;
        const v = vectors[i];
        let sim = 0;
        if (lv && v) {
          for (let d = 0; d < v.length; d += 1) sim += v[d]! * lv[d]!;
        }
        if (sim > maxSim[i]!) maxSim[i] = sim;
      }
    }
    let pick = -1;
    let pickScore = -Infinity;
    for (let i = 0; i < n; i += 1) {
      if (taken[i]) continue;
      const score = MMR_LAMBDA * rel[i]! - (last >= 0 ? (1 - MMR_LAMBDA) * maxSim[i]! : 0);
      if (score > pickScore) {
        pickScore = score;
        pick = i;
      }
    }
    taken[pick] = 1;
    out.push(ranked[pick]!);
    last = pick;
  }
  return out;
}

/**
 * The spec's match bands. s = best-chunk cosine (meaning) or cosine to the example target
 * (similar), null without embeddings; c = share of the query's distinct tokens in the entry.
 */
function matchBand(
  s: number | null,
  c: number,
  via: readonly KnowledgeMatchSignal[],
  thresholds: Pick<KnowledgeVectorThresholds, "good" | "strong"> | null
): KnowledgeMatchBand {
  const sim = thresholds && s !== null ? s : null;
  if ((sim !== null && sim >= thresholds!.strong) || (c === 1 && via.length >= 2)) return "strong";
  if ((sim !== null && sim >= thresholds!.good) || c >= 0.5 || via.includes("concept")) return "good";
  return "weak";
}

/** Every duration a text states ({@link DURATION}, global). */
const DURATIONS = new RegExp(DURATION.source, "gi");
/** Whether a clause ends at `at`: a semicolon, a line break, or a sentence end before a space. */
function clauseEndsAt(text: string, at: number): boolean {
  const char = text[at]!;
  return char === ";" || char === "\n" || ((char === "." || char === "!" || char === "?") && /\s/.test(text[at + 1] ?? " "));
}

/** Other forms a query token may take in an entry: "warm" → "warming", "warmed"; "use" → "using", "used"; "warming" → "warm", "warme". */
function termForms(term: string): string[] {
  if (term.length > 5 && term.endsWith("ing")) return [term.slice(0, -3), `${term.slice(0, -3)}e`];
  if (term.length > 4 && term.endsWith("ed")) return [term.slice(0, -2), term.slice(0, -1)];
  if (/\d/.test(term) || term.length < 3) return [];
  return term.endsWith("e") ? [`${term.slice(0, -1)}ing`, `${term}d`] : [`${term}ing`, `${term}ed`];
}

/**
 * The passage a hit shows: of an entry's chunks, the one whose cosine to the query plus
 * {@link PASSAGE_TERMS_WEIGHT} × how much of the query it holds ({@link passageScore}: its words,
 * each in any of its forms or synonyms, and a stated duration or number when it asks how long or
 * how many) is best (the best by cosine on a tie). Cosine alone picks, in a long survey, whichever
 * chunk sits nearest the query's topic; the query's own words say which one answers it.
 */
function queryPassage(hit: KnowledgeVectorHit, body: string, groups: readonly (readonly string[])[], shape: AnswerShape = null): { chunk: number; span: TextSpan } {
  const chunks = hit.chunkScores;
  if (!chunks || chunks.length < 2 || groups.length === 0) return { chunk: hit.chunk, span: hit.span };
  let best = { chunk: hit.chunk, span: hit.span };
  let bestScore = -Infinity;
  const most = groups.length + (shape === "duration" ? 2 : shape === "count" ? 0.5 : 0);
  chunks.forEach(({ score, span }, chunk) => {
    const text = body.slice(span.start, span.end);
    const total = score + (PASSAGE_TERMS_WEIGHT * passageScore(text, groups, shape)) / most;
    if (total > bestScore + 1e-9 || (Math.abs(total - bestScore) <= 1e-9 && chunk === hit.chunk)) {
      bestScore = total;
      best = { chunk, span };
    }
  });
  return best;
}

/** Distinct query words as typed (lowercased) with their tokens; words that tokenize to nothing (stopwords) are left out. */
function queryWords(query: string): { word: string; tokens: string[] }[] {
  const out: { word: string; tokens: string[] }[] = [];
  const seen = new Set<string>();
  for (const word of query.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? []) {
    if (seen.has(word)) continue;
    seen.add(word);
    const tokens = tokenize(word);
    if (tokens.length > 0) out.push({ word, tokens });
  }
  return out;
}

function firstWords(text: string, count: number): string {
  return (text.match(/\S+/g) ?? []).slice(0, count).join(" ");
}

function dotOf(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let d = 0; d < a.length; d += 1) sum += a[d]! * b[d]!;
  return sum;
}

function meanOf(vectors: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(vectors[0]!.length);
  for (const v of vectors) for (let d = 0; d < out.length; d += 1) out[d]! += v[d]! / vectors.length;
  return out;
}

/** L2-normalizes in place; false when the vector is zero. */
function normalize(v: Float32Array): boolean {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (!(norm > 1e-9)) return false;
  for (let d = 0; d < v.length; d += 1) v[d]! /= norm;
  return true;
}

function exampleIds(value: readonly string[] | undefined | null, what: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new KnowledgeError("KNOWLEDGE_INVALID", `${what} must be a list of entry ids.`);
  if (value.length > KNOWLEDGE_SIMILAR_MAX_EXAMPLES) throw new KnowledgeError("KNOWLEDGE_INVALID", `At most ${KNOWLEDGE_SIMILAR_MAX_EXAMPLES} entries in ${what}.`);
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") throw new KnowledgeError("KNOWLEDGE_INVALID", `${what} must be a list of entry ids.`);
    const id = raw.trim();
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), max));
}

function newestFirst(a: Pick<KnowledgeEntryMeta, "savedAt" | "id">, b: Pick<KnowledgeEntryMeta, "savedAt" | "id">): number {
  return b.savedAt.localeCompare(a.savedAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

// ---------------------------------------------------------------------------
// Cursors
// ---------------------------------------------------------------------------

function encodeCursor(meta: Pick<KnowledgeEntryMeta, "savedAt" | "id">): string {
  return Buffer.from(JSON.stringify([meta.savedAt, meta.id]), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): Pick<KnowledgeEntryMeta, "savedAt" | "id"> {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "string") return { savedAt: value[0], id: value[1] };
  } catch {
    // fall through
  }
  throw new KnowledgeError("KNOWLEDGE_INVALID", "The cursor is not one this server issued.");
}

function encodeSearchCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeSearchCursor(cursor: unknown): SearchCursor {
  if (typeof cursor === "string") {
    try {
      const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<SearchCursor> | null;
      if (
        value &&
        typeof value === "object" &&
        value.v === 1 &&
        Number.isInteger(value.o) &&
        value.o! >= 0 &&
        value.o! <= KNOWLEDGE_SEARCH_MAX_RESULTS &&
        typeof value.h === "string"
      ) {
        return { v: 1, o: value.o!, h: value.h };
      }
    } catch {
      // fall through
    }
  }
  throw new KnowledgeError("KNOWLEDGE_INVALID", "The cursor is not one this server issued.");
}

/** Hash of the normalized request and the caller's visibility: a cursor only continues the search that issued it. */
function searchFingerprint(request: {
  query: string;
  narrow: readonly string[] | null;
  filter: KnowledgeEntryFilter;
  similarTo: readonly string[];
  unlike: readonly string[];
  sort: KnowledgeSearchSort;
  diverse: boolean;
  visibility: KnowledgeVisibility;
}): string {
  const sorted = (values: readonly string[]) => [...values].sort();
  const key = JSON.stringify([
    request.query.replace(/\s+/g, " "),
    request.narrow ? sorted(request.narrow) : null,
    filterKey(request.filter),
    sorted(request.similarTo),
    sorted(request.unlike),
    request.sort,
    request.diverse,
    request.visibility.kind === "all" ? "all" : sorted(request.visibility.ids)
  ]);
  return createHash("sha256").update(key, "utf8").digest("base64url").slice(0, 22);
}
