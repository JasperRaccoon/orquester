import { createHash } from "node:crypto";
import type { KnowledgeVectorHit, KnowledgeVectorIndex, KnowledgeVectorThresholds } from "../ports.ts";
import type { KnowledgeLogger } from "../store/errors.ts";
import type { KnowledgeEmbedder, KnowledgeEmbedderSource } from "./embedder.ts";
import { CHUNKER_VERSION, EMBEDDING_INPUT_VERSION, type TextSpan, chunkBody, embeddingHeader, embeddingPassage } from "./text.ts";
import { VectorCache } from "./vector-cache.ts";

/** Docs embedded per worker step (small, so a query never waits long behind a backfill). */
const EMBED_BATCH_DOCS = 4;
/**
 * Chunks per model call. The model runs one call at a time, so a query (or a save) waits for at
 * most one call of this size, however long the entries being embedded are.
 */
const EMBED_CALL_CHUNKS = 4;
const FLUSH_EVERY = 64;
/** Chunks a save waits to embed (~0.1 s each on two CPU threads); the rest are embedded after it returns. */
export const SYNC_EMBED_CHUNKS = 12;
/**
 * The longest a save waits for those embeddings (spec: a save returns within about 2 s). The
 * first one after a start also loads the model; whatever is not done by then finishes in the
 * background, and the entry is searchable by text meanwhile.
 */
export const SYNC_EMBED_WAIT_MS = 1_200;

/** What an entry's vectors are computed from: the fields of its embedding header, and its body. */
export type VectorEntryText = { title: string; author: string | null; handle: string | null; kind: string; body: string };

/**
 * The vector cache key of an entry (retrieval spec, "Contextual chunks"): the sha256 of its
 * embedding header and body, so a title, author, handle or kind edit re-embeds and a relabel never does.
 */
export function vectorCacheKey(header: string, body: string): string {
  return createHash("sha256").update(`${header}\u0000${body}`, "utf8").digest("hex");
}

interface VectorDoc {
  id: string;
  /** {@link vectorCacheKey} of `header` and `body`. */
  key: string;
  header: string;
  body: string;
  spans: TextSpan[];
  /** `spans.length * dimensions` floats, or null until embedded. */
  vectors: Float32Array | null;
  vectorModel: string | null;
  /** The L2-normalized mean of `vectors` (computed on first use). */
  mean: Float32Array | null;
}

export interface InProcessVectorIndexOptions {
  embedders: KnowledgeEmbedderSource;
  /** `knowledgeIndexDir(appdir)`: the disposable vector cache. */
  indexDir: string;
  logger?: KnowledgeLogger;
  /** Overrides the model's `minimum` cosine for a chunk to count as a semantic match (tests). */
  minSimilarity?: number;
}

/**
 * The in-process {@link KnowledgeVectorIndex} (retrieval spec, "The vector index port"): every
 * entry's chunk vectors in memory, filled from the on-disk {@link VectorCache} and by an embed
 * queue (saves first, then a once-per-model backfill), scored brute force. Each chunk is embedded
 * as a passage with its entry's context header; queries are embedded as queries.
 *
 * Vectors are only answered for the current, usable embedder's model: while there is none (no
 * runtime, or the model failed) every read is empty and callers fall back to text.
 */
export class InProcessVectorIndex implements KnowledgeVectorIndex {
  private readonly embedders: KnowledgeEmbedderSource;
  private readonly indexDir: string;
  private readonly logger: KnowledgeLogger;
  private readonly minSimilarity: number | undefined;
  private readonly docs = new Map<string, VectorDoc>();
  private unsubscribe: (() => void) | null = null;
  private stopped = false;
  private changes = 0;

  private cache: VectorCache | null = null;
  /** The cache being opened, and the embedder it is opened for. */
  private cacheOpening: { embedder: KnowledgeEmbedder; done: Promise<VectorCache> } | null = null;
  private failedEmbedder: KnowledgeEmbedder | null = null;
  private backfilledModel: string | null = null;
  private readonly embedQueue: string[] = [];
  private readonly embedWaiters = new Map<string, (() => void)[]>();
  private embedWorker: Promise<void> | null = null;
  /** Set by {@link backfillAll}: every entry is tracked, so a new embedder is backfilled at once. */
  private entriesLoaded = false;
  /** The cache load and backfill {@link backfillAll} and embedder changes run, one after another. */
  private backfilling: Promise<void> | null = null;

  constructor(options: InProcessVectorIndexOptions) {
    this.embedders = options.embedders;
    this.indexDir = options.indexDir;
    this.logger = options.logger ?? console;
    this.minSimilarity = options.minSimilarity;
  }

  /**
   * Follow runtime changes: a new embedder is tried afresh and backfilled once — at once when the
   * entries are loaded ({@link backfillAll}), else by the first query or save.
   */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.embedders.onChange(() => {
      this.failedEmbedder = null;
      this.backfilledModel = null;
      this.changes += 1;
      if (this.entriesLoaded) this.scheduleBackfill();
    });
  }

  /** Stop embedding: release every waiter, finish the step in flight, flush the cache. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.release(this.embedQueue.splice(0));
    await this.idle();
    await this.cache?.flush().catch(() => undefined);
  }

  /** Resolves once queued embedding has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.backfilling || this.embedWorker) {
      await this.backfilling;
      await this.embedWorker?.catch(() => undefined);
    }
  }

  /**
   * Every entry is tracked (the start has loaded them): attach cached vectors and embed the rest in
   * the background, now and whenever the embedder changes — so similar entries, duplicates and the
   * similarity graph fill without waiting for a search. Resolves once the cached vectors are attached.
   */
  backfillAll(): Promise<void> {
    this.entriesLoaded = true;
    return this.scheduleBackfill();
  }

  /** Queue a cache load and a backfill behind the one in flight (never two at once). */
  private scheduleBackfill(): Promise<void> {
    const run = (this.backfilling ?? Promise.resolve())
      .then(async () => {
        if (this.stopped) return;
        await this.loadCached();
        this.backfill();
      })
      .catch((error: Error) => this.logger.warn(`knowledge: the embedding backfill could not start (${error.message})`));
    const tracked = run.finally(() => {
      if (this.backfilling === tracked) this.backfilling = null;
    });
    this.backfilling = tracked;
    return tracked;
  }

  // -------------------------------------------------------------------------
  // Entries
  // -------------------------------------------------------------------------

  /**
   * Track an entry's text. Unchanged header and body keep its vectors; otherwise it is re-chunked
   * and its vectors are dropped until it is embedded again (from the cache when the key is there).
   * Does not embed: see {@link embedForSave}, {@link backfill}.
   */
  setEntry(id: string, entry: VectorEntryText): void {
    const header = embeddingHeader(entry);
    const existing = this.docs.get(id);
    if (existing && existing.header === header && existing.body === entry.body) return;
    if (existing?.vectors) this.changes += 1;
    const doc: VectorDoc = { id, key: vectorCacheKey(header, entry.body), header, body: entry.body, spans: chunkBody(entry.body), vectors: null, vectorModel: null, mean: null };
    this.docs.set(id, doc);
    const embedder = this.usableEmbedder();
    if (embedder && this.cache && this.cacheMatches(this.cache, embedder)) this.attachCached(doc, this.cache, embedder);
  }

  removeEntry(id: string): void {
    const doc = this.docs.get(id);
    if (!doc) return;
    this.docs.delete(id);
    if (doc.vectors) this.changes += 1;
  }

  /** The entry's chunk count (0 when unknown). */
  chunkCount(id: string): number {
    return this.docs.get(id)?.spans.length ?? 0;
  }

  /** Attach cached vectors to every entry now (reading the cache does not load the model). */
  async loadCached(): Promise<void> {
    const embedder = this.usableEmbedder();
    if (!embedder || this.stopped) return;
    try {
      const cache = await this.cacheFor(embedder);
      if (!cache || !this.isCurrent(embedder, cache)) return;
      for (const doc of this.docs.values()) this.attachCached(doc, cache, embedder);
    } catch (error) {
      this.logger.warn(`knowledge: the embedding cache could not be read (${(error as Error).message})`);
    }
  }

  /**
   * Embed these entries first. Resolves when — up to {@link SYNC_EMBED_CHUNKS} chunks in total,
   * and for at most {@link SYNC_EMBED_WAIT_MS}, so a save stays fast — they are embedded; the rest
   * is embedded in the background.
   */
  async embedForSave(ids: readonly string[]): Promise<void> {
    const now: string[] = [];
    const later: string[] = [];
    let chunks = 0;
    for (const id of ids) {
      const spans = this.chunkCount(id);
      if (chunks + spans <= SYNC_EMBED_CHUNKS) {
        chunks += spans;
        now.push(id);
      } else {
        later.push(id);
      }
    }
    const waiting = this.requestEmbeddings(now, true);
    void this.requestEmbeddings(later, false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SYNC_EMBED_WAIT_MS);
      timer.unref?.();
    });
    await Promise.race([waiting, deadline]);
    clearTimeout(timer);
  }

  /** Embed every entry still missing vectors (once per model; see {@link backfillAll}; queries ask again). */
  backfill(): void {
    const embedder = this.usableEmbedder();
    if (!embedder || this.stopped || this.backfilledModel === embedder.modelId) return;
    this.backfilledModel = embedder.modelId;
    const missing = [...this.docs.values()].filter((doc) => !doc.vectors || doc.vectorModel !== embedder.modelId).map((doc) => doc.id);
    void this.requestEmbeddings(missing, false).then(() => this.retain());
  }

  /** Drop cached rows no entry uses any more (after deletes and the backfill). */
  async retain(): Promise<void> {
    if (!this.cache || this.stopped) return;
    await this.cache.retain(new Set([...this.docs.values()].map((doc) => doc.key))).catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // KnowledgeVectorIndex
  // -------------------------------------------------------------------------

  modelId(): string | null {
    return this.usableEmbedder()?.modelId ?? null;
  }

  thresholds(): KnowledgeVectorThresholds | null {
    const embedder = this.usableEmbedder();
    if (!embedder) return null;
    const { minimum, good, strong, duplicate } = embedder.thresholds;
    return { minimum: this.minSimilarity ?? minimum, good, strong, duplicate };
  }

  async embedQuery(text: string): Promise<Float32Array | null> {
    const embedder = this.usableEmbedder();
    if (!embedder) return null;
    this.backfill();
    try {
      const [vector] = await embedder.embed([text], "query");
      if (!vector || vector.length !== embedder.dimensions) throw new Error("the model returned a vector of the wrong size");
      return vector;
    } catch (error) {
      this.embedderFailed(embedder, error);
      return null;
    }
  }

  search(query: Float32Array, accept: (entryId: string) => boolean, limit: number, minimum?: number): KnowledgeVectorHit[] {
    const embedder = this.usableEmbedder();
    if (!embedder || limit <= 0 || query.length !== embedder.dimensions) return [];
    const model = embedder.modelId;
    const floor = minimum ?? this.minSimilarity ?? embedder.thresholds.minimum;
    const dims = embedder.dimensions;
    const hits: KnowledgeVectorHit[] = [];
    for (const doc of this.docs.values()) {
      const rows = doc.vectors;
      if (!rows || doc.vectorModel !== model || !accept(doc.id)) continue;
      let best = -Infinity;
      let bestRow = 0;
      for (let row = 0; row * dims < rows.length; row += 1) {
        let dot = 0;
        const offset = row * dims;
        for (let d = 0; d < dims; d += 1) dot += query[d]! * rows[offset + d]!;
        if (dot > best) {
          best = dot;
          bestRow = row;
        }
      }
      if (best < floor) continue;
      const span = doc.spans[bestRow] ?? { start: 0, end: doc.body.length };
      hits.push({ entryId: doc.id, score: best, chunk: bestRow, chunks: doc.spans.length, span: { start: span.start, end: span.end } });
    }
    return hits.sort((a, b) => b.score - a.score || (a.entryId < b.entryId ? -1 : 1)).slice(0, limit);
  }

  /** The cached mean vector; callers must not modify it. */
  entryVector(entryId: string): Float32Array | null {
    const model = this.modelId();
    const doc = this.docs.get(entryId);
    if (!model || !doc?.vectors || doc.vectorModel !== model) return null;
    doc.mean ??= meanVector(doc.vectors, doc.vectors.length / doc.spans.length);
    return doc.mean;
  }

  embeddedIds(): string[] {
    const model = this.modelId();
    if (!model) return [];
    const out: string[] = [];
    for (const doc of this.docs.values()) if (doc.vectors && doc.vectorModel === model) out.push(doc.id);
    return out;
  }

  generation(): number {
    return this.changes;
  }

  // -------------------------------------------------------------------------
  // Embedding
  // -------------------------------------------------------------------------

  private usableEmbedder(): KnowledgeEmbedder | null {
    const embedder = this.embedders.current();
    return embedder && embedder !== this.failedEmbedder ? embedder : null;
  }

  private embedderFailed(embedder: KnowledgeEmbedder, error: unknown): void {
    if (this.failedEmbedder !== embedder) {
      this.logger.warn(`knowledge: embeddings are unavailable, searching by text only (${(error as Error).message ?? String(error)})`);
      this.changes += 1;
    }
    this.failedEmbedder = embedder;
  }

  private cacheMatches(cache: VectorCache, embedder: KnowledgeEmbedder): boolean {
    return cache.modelId === embedder.modelId && cache.dimensions === embedder.dimensions;
  }

  /** The embedder is still the one to use, and `cache` is its open cache: its vectors may be read, put and flushed. */
  private isCurrent(embedder: KnowledgeEmbedder, cache: VectorCache): boolean {
    return !this.stopped && this.usableEmbedder() === embedder && this.cache === cache && this.cacheMatches(cache, embedder);
  }

  /**
   * The open cache of `embedder`'s model (opened when needed, one at a time; the cache directory
   * holds one model's vectors). Null once `embedder` is no longer the one to use: a cache opened
   * for an older model is never handed out for a newer one.
   */
  private async cacheFor(embedder: KnowledgeEmbedder): Promise<VectorCache | null> {
    for (;;) {
      if (this.stopped || this.usableEmbedder() !== embedder) return null;
      if (this.cache && this.cacheMatches(this.cache, embedder)) return this.cache;
      const opening = this.cacheOpening;
      if (opening) {
        // Another model's cache is being opened: wait for it, then look again.
        if (opening.embedder !== embedder) await opening.done.catch(() => undefined);
        else await opening.done;
        continue;
      }
      const done = (async () => {
        await this.cache?.flush().catch(() => undefined);
        const cache = await VectorCache.open({
          dir: this.indexDir,
          modelId: embedder.modelId,
          dimensions: embedder.dimensions,
          chunker: CHUNKER_VERSION,
          input: EMBEDDING_INPUT_VERSION,
          logger: this.logger
        });
        this.cache = cache;
        return cache;
      })().finally(() => {
        if (this.cacheOpening?.done === done) this.cacheOpening = null;
      });
      this.cacheOpening = { embedder, done };
    }
  }

  private attachCached(doc: VectorDoc, cache: VectorCache, embedder: KnowledgeEmbedder): boolean {
    if (doc.vectors && doc.vectorModel === embedder.modelId) return true;
    const cached = cache.get(doc.key);
    if (!cached || cached.length !== doc.spans.length * embedder.dimensions) return false;
    this.setVectors(doc, cached, embedder.modelId);
    return true;
  }

  private setVectors(doc: VectorDoc, rows: Float32Array, model: string): void {
    doc.vectors = rows;
    doc.vectorModel = model;
    doc.mean = null;
    this.changes += 1;
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
        // The embedder changed meanwhile: drop the batch (the new embedder's backfill embeds it).
        if (!cache || !this.isCurrent(embedder, cache)) continue;
        const todo: VectorDoc[] = [];
        for (const id of ids) {
          const doc = this.docs.get(id);
          if (doc && !this.attachCached(doc, cache, embedder)) todo.push(doc);
        }
        if (todo.length > 0) {
          const texts = todo.flatMap((doc) => doc.spans.map((span) => embeddingPassage(doc.header, doc.body.slice(span.start, span.end))));
          const vectors: Float32Array[] = [];
          for (let start = 0; start < texts.length; start += EMBED_CALL_CHUNKS) {
            if (this.stopped) return; // `stop()` already released every waiter and flushes the cache
            vectors.push(...(await embedder.embed(texts.slice(start, start + EMBED_CALL_CHUNKS), "passage")));
          }
          let at = 0;
          for (const doc of todo) {
            const rows = new Float32Array(doc.spans.length * embedder.dimensions);
            for (let i = 0; i < doc.spans.length; i += 1) {
              const vector = vectors[at++];
              if (!vector || vector.length !== embedder.dimensions) throw new Error("the model returned a vector of the wrong size");
              rows.set(vector, i * embedder.dimensions);
            }
            // A batch embedded by a model that is no longer current is dropped, never filed or
            // attached (the new model's backfill embeds it again).
            if (!this.isCurrent(embedder, cache)) break;
            // The entry may have been edited meanwhile; only a still-current doc takes the rows.
            if (this.docs.get(doc.id) === doc) this.setVectors(doc, rows, embedder.modelId);
            await cache.put(doc.key, rows);
          }
          sinceFlush += todo.length;
          if (sinceFlush >= FLUSH_EVERY && this.isCurrent(embedder, cache)) {
            await cache.flush();
            sinceFlush = 0;
          }
        }
      } catch (error) {
        // A replaced embedder (released by its source) failing is no news about the current one.
        if (this.embedders.current() === embedder) this.embedderFailed(embedder, error);
      } finally {
        this.release(ids);
      }
    }
    if (sinceFlush > 0) await this.cache?.flush().catch(() => undefined);
  }
}

/** The L2-normalized mean of `rows` (row after row of `dims` floats). */
function meanVector(rows: Float32Array, dims: number): Float32Array {
  const mean = new Float32Array(dims);
  const count = rows.length / dims;
  for (let row = 0; row < count; row += 1) {
    const offset = row * dims;
    for (let d = 0; d < dims; d += 1) mean[d]! += rows[offset + d]!;
  }
  let norm = 0;
  for (let d = 0; d < dims; d += 1) norm += mean[d]! * mean[d]!;
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < dims; d += 1) mean[d]! /= norm;
  return mean;
}
