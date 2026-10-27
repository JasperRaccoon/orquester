import { createHash } from "node:crypto";
import type { KnowledgeLogger } from "../store/errors.ts";
import type { KnowledgeEmbedder, KnowledgeEmbedderSource } from "./embedder.ts";
import { VectorCache } from "./vector-cache.ts";

/** `VectorCache` `chunker` of concept vectors: one vector per concept text. */
export const CONCEPT_VECTORS_CHUNKER = "concept-1";
/** `VectorCache` `input`: what {@link conceptEmbeddingText} builds (bump when it changes). */
export const CONCEPT_EMBEDDING_INPUT_VERSION = "concept-text-1";
/**
 * Concept texts per model call (phase 2 spec, "Performance": ≤ 16). The embedder runs one call at
 * a time and is shared with query embedding, so a search waits behind at most one such call.
 */
export const CONCEPT_EMBED_BATCH = 16;

/** What a concept's vector is computed from. */
export interface ConceptText {
  id: string;
  type: string;
  name: string;
  aliases: readonly string[];
  description: string | null;
}

/** `"<type>: <name>. <aliases>. <description>"` (empty parts left out), embedded as a passage. */
export function conceptEmbeddingText(concept: ConceptText): string {
  const aliases = concept.aliases.map((alias) => alias.trim()).filter((alias) => alias.length > 0);
  return [`${concept.type}: ${concept.name.trim()}`, aliases.join(", "), concept.description?.trim() ?? ""].filter((part) => part.length > 0).join(". ");
}

/** The cache key of a concept text (sha256 hex): the same text is embedded once. */
export function conceptVectorKey(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Every concept's vector from one model (L2-normalized: a dot product is the cosine). */
export interface ConceptVectorSet {
  modelId: string;
  vectors: ReadonlyMap<string, Float32Array>;
}

export interface ConceptVectorsOptions {
  embedders: KnowledgeEmbedderSource;
  /** `<knowledgeIndexDir>/concepts`: its own directory, since a `VectorCache` removes stray vector files in its dir. */
  dir: string;
  logger?: KnowledgeLogger;
  /** Waits between batches (default: one turn of the event loop). */
  pause?: () => Promise<void>;
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Concept vectors (phase 2 spec, "Concept vectors"): every concept of the graph embedded with the
 * active embedder, in the background — small batches with a turn of the event loop between them,
 * never awaited by a load or a search — and cached on disk by text hash, so a graph reload only
 * embeds new or changed concepts. A newer graph or another model restarts the computation; a set
 * is published ({@link current}, {@link onComputed}) only once every concept has its vector.
 */
export class ConceptVectors {
  private readonly embedders: KnowledgeEmbedderSource;
  private readonly dir: string;
  private readonly logger: KnowledgeLogger;
  private readonly pause: () => Promise<void>;
  private concepts: readonly ConceptText[] | null = null;
  private set: ConceptVectorSet | null = null;
  private cache: VectorCache | null = null;
  private dirty = false;
  private running: Promise<void> | null = null;
  private stopped = false;
  private unsubscribe: (() => void) | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(options: ConceptVectorsOptions) {
    this.embedders = options.embedders;
    this.dir = options.dir;
    this.logger = options.logger ?? console;
    this.pause = options.pause ?? nextTurn;
  }

  /** Follow embedder changes (a new model recomputes every vector). */
  start(): void {
    if (this.unsubscribe || this.stopped) return;
    this.unsubscribe = this.embedders.onChange(() => {
      if (this.concepts) this.schedule();
    });
  }

  /** Stop computing (the batch in flight finishes) and flush the cache. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.idle();
    await this.cache?.flush().catch(() => undefined);
  }

  /** The graph's concepts changed (a load): compute their vectors in the background. */
  update(concepts: readonly ConceptText[]): void {
    this.concepts = concepts;
    this.schedule();
  }

  /** The vectors of the latest complete computation, when they come from the current embedder's model; else null. */
  current(): ConceptVectorSet | null {
    const set = this.set;
    const embedder = this.embedders.current();
    return set && embedder && set.modelId === embedder.modelId ? set : null;
  }

  /** Called after each complete computation. */
  onComputed(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves once no computation is running or queued (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.dirty = true;
    if (this.running) return;
    const run = (async () => {
      while (this.dirty && !this.stopped) {
        this.dirty = false;
        await this.compute().catch((error: Error) => this.logger.warn(`knowledge: computing concept vectors failed (${error.message})`));
      }
    })();
    const tracked: Promise<void> = run.finally(() => {
      if (this.running === tracked) this.running = null;
    });
    this.running = tracked;
  }

  /** The open cache of the embedder's model (another model's cache is flushed and replaced). */
  private async cacheFor(embedder: KnowledgeEmbedder): Promise<VectorCache> {
    if (this.cache && this.cache.modelId === embedder.modelId && this.cache.dimensions === embedder.dimensions) return this.cache;
    await this.cache?.flush().catch(() => undefined);
    this.cache = null;
    this.cache = await VectorCache.open({
      dir: this.dir,
      modelId: embedder.modelId,
      dimensions: embedder.dimensions,
      chunker: CONCEPT_VECTORS_CHUNKER,
      input: CONCEPT_EMBEDDING_INPUT_VERSION,
      logger: this.logger
    });
    return this.cache;
  }

  private async compute(): Promise<void> {
    const embedder = this.embedders.current();
    const concepts = this.concepts;
    if (!embedder || !concepts) return;
    const cache = await this.cacheFor(embedder);
    const vectors = new Map<string, Float32Array>();
    const missing: { id: string; key: string; text: string }[] = [];
    const live = new Set<string>();
    for (const concept of concepts) {
      const text = conceptEmbeddingText(concept);
      const key = conceptVectorKey(text);
      live.add(key);
      const cached = cache.get(key);
      if (cached && cached.length === embedder.dimensions) vectors.set(concept.id, cached);
      else missing.push({ id: concept.id, key, text });
    }
    let complete = true;
    try {
      // Concepts sharing a text are embedded once.
      const byKey = new Map<string, { text: string; ids: string[] }>();
      for (const item of missing) {
        const known = byKey.get(item.key);
        if (known) known.ids.push(item.id);
        else byKey.set(item.key, { text: item.text, ids: [item.id] });
      }
      const todo = [...byKey];
      for (let start = 0; start < todo.length; start += CONCEPT_EMBED_BATCH) {
        // A newer graph, another model or a stop: this computation is moot (the cache keeps its progress).
        if (this.stopped || this.dirty || this.embedders.current() !== embedder) {
          complete = false;
          return;
        }
        if (start > 0) await this.pause();
        const batch = todo.slice(start, start + CONCEPT_EMBED_BATCH);
        const out = await embedder.embed(
          batch.map(([, item]) => item.text),
          "passage"
        );
        for (let i = 0; i < batch.length; i += 1) {
          const vector = out[i];
          if (!vector || vector.length !== embedder.dimensions) throw new Error("the model returned a vector of the wrong size");
          const [key, item] = batch[i]!;
          await cache.put(key, vector);
          for (const id of item.ids) vectors.set(id, vector);
        }
      }
    } catch (error) {
      complete = false;
      throw error;
    } finally {
      await cache.flush().catch(() => undefined);
    }
    if (!complete || this.stopped || this.embedders.current() !== embedder) return;
    await cache.retain(live).catch(() => undefined);
    this.set = { modelId: embedder.modelId, vectors };
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        this.logger.warn(`knowledge: a concept vectors listener failed (${(error as Error).message})`);
      }
    }
  }
}
