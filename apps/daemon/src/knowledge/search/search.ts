import {
  KNOWLEDGE_GRAPH_MAX_NODES,
  KNOWLEDGE_SEARCH_DEFAULT_LIMIT,
  KNOWLEDGE_SEARCH_MAX_LIMIT,
  knowledgeCitation,
  type KnowledgeCollection,
  type KnowledgeConceptDetail,
  type KnowledgeEntriesResponse,
  type KnowledgeEntryDetail,
  type KnowledgeEntryMeta,
  type KnowledgeEntrySummary,
  type KnowledgeGraphResponse,
  type KnowledgeItemResponse,
  type KnowledgeSearchHit,
  type KnowledgeSearchResponse,
  type KnowledgeVisibility
} from "@orquester/api";
import { isKnowledgeEntryId } from "@orquester/config";
import type { KnowledgeEntryChange, KnowledgeStorePort } from "../ports.ts";
import { KnowledgeError, type KnowledgeLogger } from "../store/errors.ts";
import { knowledgeContentHash } from "../store/normalize.ts";
import { Bm25Index } from "./bm25.ts";
import type { KnowledgeEmbedder, KnowledgeEmbedderSource } from "./embedder.ts";
import type { KnowledgeGraph } from "./graph.ts";
import { CHUNKER_VERSION, type TextSpan, bestSnippet, chunkBody, leadSnippet, tokenize } from "./text.ts";
import { VectorCache } from "./vector-cache.ts";
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
  /** Cosine similarity a chunk needs to count as a semantic match (default 0.25). */
  minSimilarity?: number;
}

export const KNOWLEDGE_ENTRIES_DEFAULT_LIMIT = 50;
export const KNOWLEDGE_ENTRIES_MAX_LIMIT = 200;
export const KNOWLEDGE_QUERY_MAX = 1_000;
const RELATED_LIMIT = 8;
const CONCEPT_ENTRIES_LIMIT = 50;
const CANDIDATES = 50;
const RRF_K = 60;
const WEIGHT = { bm25: 1, vector: 1, expansion: 0.5, concept: 1 } as const;
/** The best possible entry score (first in every list), so scores land in 0..1. */
const SCORE_SCALE = (WEIGHT.bm25 + WEIGHT.vector + WEIGHT.expansion) / (RRF_K + 1);
/** Docs embedded per worker step (small, so a query never waits long behind a backfill). */
const EMBED_BATCH_DOCS = 4;
/**
 * Chunks per model call. The model runs one call at a time, so a query (or a save) waits for at
 * most one call of this size, however long the entries being embedded are.
 */
const EMBED_CALL_CHUNKS = 4;
const FLUSH_EVERY = 64;
/** Chunks a save waits to embed (~0.1 s each on two CPU threads); the rest are embedded after it returns. */
const SYNC_EMBED_CHUNKS = 12;

interface Doc {
  id: string;
  hash: string;
  body: string;
  spans: TextSpan[];
  /** `spans.length * dimensions` floats, or null until embedded. */
  vectors: Float32Array | null;
  vectorModel: string | null;
}

/**
 * Hybrid search and the read views over the knowledge base (spec "Querying"):
 *
 * 1. embedding similarity over entry chunks (when the runtime is installed);
 * 2. BM25 over entries (title, body, author, handle) and concepts (name, aliases, attributes);
 * 3. a one-hop expansion through visible concepts;
 *
 * fused with reciprocal-rank fusion. Every step is scoped by visibility while it ranks. A new
 * entry is searchable (text, and meaning once embedded) as soon as it is indexed, before linking.
 * Without a runtime — or when the model fails — search runs on BM25 and the graph alone.
 */
export class KnowledgeSearch {
  private readonly store: KnowledgeSearchStore;
  private readonly graph: KnowledgeGraph;
  private readonly embedders: KnowledgeEmbedderSource;
  private readonly indexDir: string;
  private readonly logger: KnowledgeLogger;
  private readonly minSimilarity: number;
  private readonly docs = new Map<string, Doc>();
  private readonly bm25 = new Bm25Index();
  private ready: Promise<void> | null = null;
  private textChain: Promise<unknown> = Promise.resolve();
  private readonly unsubscribers: (() => void)[] = [];
  private stopped = false;

  private cache: VectorCache | null = null;
  private cacheOpening: Promise<VectorCache> | null = null;
  private failedEmbedder: KnowledgeEmbedder | null = null;
  private backfilledModel: string | null = null;
  private readonly embedQueue: string[] = [];
  private readonly embedWaiters = new Map<string, (() => void)[]>();
  private embedWorker: Promise<void> | null = null;

  constructor(options: KnowledgeSearchOptions) {
    this.store = options.store;
    this.graph = options.graph;
    this.embedders = options.embedders;
    this.indexDir = options.indexDir;
    this.logger = options.logger ?? console;
    this.minSimilarity = options.minSimilarity ?? 0.25;
  }

  /** Subscribe to the store and index every entry's text (in the background; queries wait for it). */
  start(): Promise<void> {
    if (this.ready) return this.ready;
    this.unsubscribers.push(this.store.onChange((change) => this.onStoreChange(change)));
    this.unsubscribers.push(
      this.embedders.onChange(() => {
        this.failedEmbedder = null;
        this.backfilledModel = null;
      })
    );
    this.ready = this.loadAll();
    return this.ready;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.release(this.embedQueue.splice(0));
    await this.ready?.catch(() => undefined);
    await this.textChain.catch(() => undefined);
    while (this.embedWorker) await this.embedWorker.catch(() => undefined);
    await this.cache?.flush().catch(() => undefined);
  }

  /**
   * Index these entries now: text at once, embeddings first in the queue. Resolves when they are
   * searchable by text and — up to {@link SYNC_EMBED_CHUNKS} chunks in total, so a save stays
   * fast — by meaning; longer bodies finish embedding in the background.
   */
  async indexEntries(ids: readonly string[]): Promise<void> {
    await this.whenReady();
    await this.serializeText(async () => {
      for (const id of ids) await this.indexText(id);
    });
    const now: string[] = [];
    const later: string[] = [];
    let chunks = 0;
    for (const id of ids) {
      const spans = this.docs.get(id)?.spans.length ?? 0;
      if (chunks + spans <= SYNC_EMBED_CHUNKS) {
        chunks += spans;
        now.push(id);
      } else {
        later.push(id);
      }
    }
    const waiting = this.requestEmbeddings(now, true);
    void this.requestEmbeddings(later, false);
    await waiting;
  }

  /** Resolves once queued text indexing and embedding have finished (tests, shutdown). */
  async idle(): Promise<void> {
    await this.whenReady();
    await this.textChain.catch(() => undefined);
    while (this.embedWorker) await this.embedWorker.catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  async search(
    request: { query: string; collections?: readonly string[]; limit?: number },
    visibility: KnowledgeVisibility
  ): Promise<KnowledgeSearchResponse> {
    const query = request.query.trim();
    if (query.length === 0) throw new KnowledgeError("KNOWLEDGE_INVALID", "The query is empty.");
    if (query.length > KNOWLEDGE_QUERY_MAX) throw new KnowledgeError("KNOWLEDGE_INVALID", `The query is longer than ${KNOWLEDGE_QUERY_MAX} characters.`);
    const limit = clampLimit(request.limit, KNOWLEDGE_SEARCH_DEFAULT_LIMIT, KNOWLEDGE_SEARCH_MAX_LIMIT);
    const narrow = request.collections && request.collections.length > 0 ? this.resolveVisible(request.collections, visibility, false) : null;
    await this.whenReady();
    const collections = this.store.listCollections();
    const scope = knowledgeScope(visibility, collections.map((c) => c.id), narrow);
    const searched = scopeCollectionIds(scope, collections.map((c) => c.id));
    const visible = (id: string): boolean => {
      const meta = this.store.getMeta(id);
      return meta !== null && entryInScope(meta, scope);
    };
    const terms = tokenize(query);

    // 1. Meaning.
    const vectorHits = await this.vectorSearch(query, visible);
    // 2. Words.
    const textHits = this.bm25.search(terms, visible, CANDIDATES).map((hit) => hit.key);
    const conceptHits = this.graph.searchConcepts(terms, scope, CANDIDATES).map((hit) => hit.id);
    // 3. One hop through visible concepts: the best concepts, and the concepts of the best entries.
    const preliminary = fuse([
      [textHits, WEIGHT.bm25],
      [vectorHits.map((hit) => hit.id), WEIGHT.vector]
    ]);
    const seeds = [...conceptHits.slice(0, 5)];
    for (const [entryId] of [...preliminary].slice(0, 3)) {
      for (const concept of this.graph.conceptsOfEntry(entryId)) if (!seeds.includes(concept.id)) seeds.push(concept.id);
    }
    const expansionScores = new Map<string, number>();
    seeds.forEach((conceptId, rank) => {
      for (const entryId of this.graph.visibleEntriesOf(conceptId, scope)) {
        expansionScores.set(entryId, (expansionScores.get(entryId) ?? 0) + 1 / (1 + rank));
      }
    });
    const expansion = [...expansionScores]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, CANDIDATES)
      .map(([id]) => id);

    const entryScores = fuse([
      [textHits, WEIGHT.bm25],
      [vectorHits.map((hit) => hit.id), WEIGHT.vector],
      [expansion, WEIGHT.expansion]
    ]);
    const conceptScores = fuse([[conceptHits, WEIGHT.concept]]);
    const spanOf = new Map(vectorHits.map((hit) => [hit.id, hit.span]));

    const maxConcepts = Math.max(1, Math.floor(limit / 3));
    const ranked: ({ kind: "entry"; id: string; score: number } | { kind: "concept"; id: string; score: number })[] = [
      ...[...entryScores].map(([id, score]) => ({ kind: "entry" as const, id, score })),
      ...[...conceptScores].slice(0, maxConcepts).map(([id, score]) => ({ kind: "concept" as const, id, score }))
    ].sort((a, b) => b.score - a.score || (a.kind === b.kind ? (a.id < b.id ? -1 : 1) : a.kind === "entry" ? -1 : 1));

    const hits: KnowledgeSearchHit[] = [];
    for (const item of ranked) {
      if (hits.length >= limit) break;
      const score = Math.round((item.score / SCORE_SCALE) * 1e4) / 1e4;
      if (item.kind === "entry") {
        const meta = this.store.getMeta(item.id);
        const doc = this.docs.get(item.id);
        if (!meta) continue;
        const snippet = doc ? bestSnippet(doc.body, terms, spanOf.get(item.id)) : "";
        hits.push({ kind: "entry", score, entry: this.summary(meta, scope, snippet) });
      } else {
        const ref = this.graph.conceptRef(item.id);
        if (!ref) continue;
        const entryIds = this.graph
          .visibleEntriesOf(item.id, scope)
          .map((id) => ({ id, score: entryScores.get(id) ?? 0, savedAt: this.store.getMeta(id)?.savedAt ?? "" }))
          .sort((a, b) => b.score - a.score || b.savedAt.localeCompare(a.savedAt) || (a.id < b.id ? -1 : 1))
          .slice(0, 3)
          .map((e) => e.id);
        hits.push({ kind: "concept", score, concept: ref, entryIds });
      }
    }
    return { hits, searched };
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
    const doc = this.docs.get(meta.id);
    return {
      ...meta,
      savedFrom: { ...meta.savedFrom },
      collections: visibleCollections(meta, scope),
      snippet: snippet ?? (doc ? leadSnippet(doc.body) : ""),
      linkCount: this.graph.linkCount(meta.id),
      citation: knowledgeCitation(meta)
    };
  }

  /** Newest first; `collection` is an id, `unfiled`, or absent. */
  async listEntries(
    query: { collection?: string; cursor?: string; limit?: number },
    visibility: KnowledgeVisibility
  ): Promise<KnowledgeEntriesResponse> {
    await this.whenReady();
    const limit = clampLimit(query.limit, KNOWLEDGE_ENTRIES_DEFAULT_LIMIT, KNOWLEDGE_ENTRIES_MAX_LIMIT);
    const narrow = query.collection ? this.resolveVisible([query.collection], visibility, true) : null;
    const scope = this.scope(visibility, narrow);
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    const metas = this.store
      .listMeta()
      .filter((meta) => entryInScope(meta, scope))
      .sort(newestFirst)
      .filter((meta) => !after || newestFirst(meta, after) > 0);
    const page = metas.slice(0, limit);
    const last = page[page.length - 1];
    return {
      entries: page.map((meta) => this.summary(meta, scope)),
      nextCursor: metas.length > limit && last ? encodeCursor(last) : null
    };
  }

  /** A visible entry with its concepts and related entries; null when hidden or unknown. */
  async entryDetail(id: string, visibility: KnowledgeVisibility): Promise<KnowledgeEntryDetail | null> {
    await this.whenReady();
    const scope = this.scope(visibility);
    const meta = this.store.getMeta(id);
    if (!meta || !entryInScope(meta, scope)) return null;
    const entry = await this.store.getEntry(id);
    if (!entry) return null;
    const related = this.graph
      .relatedEntries(id, scope, RELATED_LIMIT)
      .map((r) => this.store.getMeta(r.id))
      .filter((m): m is KnowledgeEntryMeta => m !== null)
      .map((m) => this.summary(m, scope));
    return {
      entry: { ...entry, savedFrom: { ...entry.savedFrom }, collections: visibleCollections(entry, scope) },
      concepts: this.graph.conceptsOfEntry(id),
      related,
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
    const entries = view.entryIds
      .map((entryId) => this.store.getMeta(entryId))
      .filter((m): m is KnowledgeEntryMeta => m !== null)
      .sort(newestFirst)
      .slice(0, CONCEPT_ENTRIES_LIMIT)
      .map((m) => this.summary(m, scope));
    return { concept: view.concept, collections: view.collections, entries, neighbors: view.neighbors };
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
    if (change.kind === "relabelled") return; // visibility reads collections from the store live
    if (change.kind === "deleted") {
      void this.whenReady().then(() =>
        this.serializeText(async () => {
          for (const id of change.entryIds) this.removeDoc(id);
          await this.retainCache();
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
    // Attach cached vectors now (reading the cache does not load the model); the rest are
    // embedded by the backfill the first query or save starts.
    const embedder = this.usableEmbedder();
    if (!embedder) return;
    try {
      const cache = await this.cacheFor(embedder);
      for (const doc of this.docs.values()) this.attachCached(doc, cache, embedder);
    } catch (error) {
      this.logger.warn(`knowledge: the embedding cache could not be read (${(error as Error).message})`);
    }
  }

  private attachCached(doc: Doc, cache: VectorCache, embedder: KnowledgeEmbedder): boolean {
    if (doc.vectors && doc.vectorModel === embedder.modelId) return true;
    const cached = cache.get(doc.hash);
    if (!cached || cached.length !== doc.spans.length * embedder.dimensions) return false;
    doc.vectors = cached;
    doc.vectorModel = embedder.modelId;
    return true;
  }

  private async indexText(id: string): Promise<void> {
    const meta = this.store.getMeta(id);
    const entry = meta ? await this.store.getEntry(id) : null;
    if (!meta || !entry) {
      this.removeDoc(id);
      return;
    }
    const existing = this.docs.get(id);
    // The vector cache key is the hash of the text embedded here, never the hash the metadata
    // claims: a hand-edited file (or a read racing an edit) must not file vectors under another body.
    const doc: Doc =
      existing && existing.body === entry.body
        ? existing
        : { id, hash: knowledgeContentHash(entry.body), body: entry.body, spans: chunkBody(entry.body), vectors: null, vectorModel: null };
    this.docs.set(id, doc);
    this.bm25.add(id, [
      { tokens: tokenize(entry.title), weight: 3 },
      { tokens: tokenize(entry.body), weight: 1 },
      { tokens: tokenize([entry.author ?? "", entry.handle ?? ""].join(" ")), weight: 2 }
    ]);
  }

  private removeDoc(id: string): void {
    this.docs.delete(id);
    this.bm25.remove(id);
  }

  private usableEmbedder(): KnowledgeEmbedder | null {
    const embedder = this.embedders.current();
    return embedder && embedder !== this.failedEmbedder ? embedder : null;
  }

  private embedderFailed(embedder: KnowledgeEmbedder, error: unknown): void {
    if (this.failedEmbedder !== embedder) {
      this.logger.warn(`knowledge: embeddings are unavailable, searching by text only (${(error as Error).message ?? String(error)})`);
    }
    this.failedEmbedder = embedder;
  }

  private async cacheFor(embedder: KnowledgeEmbedder): Promise<VectorCache> {
    if (this.cache && this.cache.modelId === embedder.modelId) return this.cache;
    if (!this.cacheOpening) {
      this.cacheOpening = (async () => {
        await this.cache?.flush().catch(() => undefined);
        const cache = await VectorCache.open({
          dir: this.indexDir,
          modelId: embedder.modelId,
          dimensions: embedder.dimensions,
          chunker: CHUNKER_VERSION,
          logger: this.logger
        });
        this.cache = cache;
        return cache;
      })().finally(() => {
        this.cacheOpening = null;
      });
    }
    return this.cacheOpening;
  }

  /** Queue entries for embedding (front of the queue when `priority`); resolves when they are done or skipped. */
  private requestEmbeddings(ids: readonly string[], priority: boolean): Promise<void> {
    if (this.stopped || !this.usableEmbedder() || ids.length === 0) return Promise.resolve();
    const waits = ids.map(
      (id) =>
        new Promise<void>((resolve) => {
          const list = this.embedWaiters.get(id) ?? [];
          list.push(resolve);
          this.embedWaiters.set(id, list);
        })
    );
    if (priority) {
      for (const id of ids) {
        const at = this.embedQueue.indexOf(id);
        if (at >= 0) this.embedQueue.splice(at, 1);
      }
      this.embedQueue.unshift(...ids);
    } else {
      const queued = new Set(this.embedQueue);
      this.embedQueue.push(...ids.filter((id) => !queued.has(id)));
    }
    this.kickEmbedWorker();
    return Promise.all(waits).then(() => undefined);
  }

  private kickEmbedWorker(): void {
    if (this.embedWorker || this.embedQueue.length === 0) return;
    this.embedWorker = this.runEmbedWorker().finally(() => {
      this.embedWorker = null;
      // Entries queued while the worker was finishing get a new run.
      this.kickEmbedWorker();
    });
  }

  private release(ids: readonly string[]): void {
    for (const id of ids) {
      const list = this.embedWaiters.get(id);
      this.embedWaiters.delete(id);
      for (const resolve of list ?? []) resolve();
    }
  }

  private async runEmbedWorker(): Promise<void> {
    let sinceFlush = 0;
    while (this.embedQueue.length > 0) {
      const ids = this.embedQueue.splice(0, EMBED_BATCH_DOCS);
      const embedder = this.usableEmbedder();
      if (!embedder) {
        this.release([...ids, ...this.embedQueue.splice(0)]);
        break;
      }
      try {
        const cache = await this.cacheFor(embedder);
        const todo: Doc[] = [];
        for (const id of ids) {
          const doc = this.docs.get(id);
          if (doc && !this.attachCached(doc, cache, embedder)) todo.push(doc);
        }
        if (todo.length > 0) {
          const texts = todo.flatMap((doc) => doc.spans.map((span) => doc.body.slice(span.start, span.end)));
          const vectors: Float32Array[] = [];
          for (let start = 0; start < texts.length; start += EMBED_CALL_CHUNKS) {
            if (this.stopped) return; // `stop()` already released every waiter and flushes the cache
            vectors.push(...(await embedder.embed(texts.slice(start, start + EMBED_CALL_CHUNKS))));
          }
          let at = 0;
          for (const doc of todo) {
            const rows = new Float32Array(doc.spans.length * embedder.dimensions);
            for (let i = 0; i < doc.spans.length; i += 1) {
              const vector = vectors[at++];
              if (!vector || vector.length !== embedder.dimensions) throw new Error("the model returned a vector of the wrong size");
              rows.set(vector, i * embedder.dimensions);
            }
            // The entry may have been edited meanwhile; only a still-current doc takes the rows.
            if (this.docs.get(doc.id) === doc) {
              doc.vectors = rows;
              doc.vectorModel = embedder.modelId;
            }
            await cache.put(doc.hash, rows);
          }
          sinceFlush += todo.length;
          if (sinceFlush >= FLUSH_EVERY) {
            await cache.flush();
            sinceFlush = 0;
          }
        }
      } catch (error) {
        this.embedderFailed(embedder, error);
      } finally {
        this.release(ids);
      }
    }
    if (sinceFlush > 0) await this.cache?.flush().catch(() => undefined);
  }

  /** Embed every entry still missing vectors (once per model; started by the first query or save). */
  private backfill(embedder: KnowledgeEmbedder): void {
    if (this.backfilledModel === embedder.modelId) return;
    this.backfilledModel = embedder.modelId;
    const missing = [...this.docs.values()].filter((doc) => !doc.vectors || doc.vectorModel !== embedder.modelId).map((doc) => doc.id);
    void this.requestEmbeddings(missing, false).then(() => this.retainCache());
  }

  private async retainCache(): Promise<void> {
    if (!this.cache || this.stopped) return;
    await this.cache.retain(new Set([...this.docs.values()].map((doc) => doc.hash))).catch(() => undefined);
  }

  private async vectorSearch(query: string, visible: (id: string) => boolean): Promise<{ id: string; score: number; span: TextSpan }[]> {
    const embedder = this.usableEmbedder();
    if (!embedder) return [];
    this.backfill(embedder);
    let q: Float32Array;
    try {
      const [vector] = await embedder.embed([query]);
      if (!vector || vector.length !== embedder.dimensions) throw new Error("the model returned a vector of the wrong size");
      q = vector;
    } catch (error) {
      this.embedderFailed(embedder, error);
      return [];
    }
    const dims = embedder.dimensions;
    const hits: { id: string; score: number; span: TextSpan }[] = [];
    for (const doc of this.docs.values()) {
      const rows = doc.vectors;
      if (!rows || doc.vectorModel !== embedder.modelId) continue;
      let best = -1;
      let bestRow = 0;
      for (let row = 0; row * dims < rows.length; row += 1) {
        let dot = 0;
        const offset = row * dims;
        for (let d = 0; d < dims; d += 1) dot += q[d]! * rows[offset + d]!;
        if (dot > best) {
          best = dot;
          bestRow = row;
        }
      }
      if (best < this.minSimilarity || !visible(doc.id)) continue;
      hits.push({ id: doc.id, score: best, span: doc.spans[bestRow] ?? { start: 0, end: doc.body.length } });
    }
    return hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1)).slice(0, CANDIDATES);
  }
}

/** Reciprocal-rank fusion: Σ weight / (k + rank), rank from 1. Insertion order is best first. */
function fuse(lists: readonly (readonly [readonly string[], number])[]): Map<string, number> {
  const scores = new Map<string, number>();
  for (const [list, weight] of lists) {
    list.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + weight / (RRF_K + index + 1)));
  }
  return new Map([...scores].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), max));
}

function newestFirst(a: Pick<KnowledgeEntryMeta, "savedAt" | "id">, b: Pick<KnowledgeEntryMeta, "savedAt" | "id">): number {
  return b.savedAt.localeCompare(a.savedAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

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
