/**
 * Knowledge Graph plugin — the seams between its daemon modules (spec
 * docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md).
 *
 * - `install/`    the runtime (uv, the pinned myKG venv with its prompt overlay,
 *                 the embedding model) and the plugin's settings.
 * - `store/`      entries, collections, the myKG input mirror.
 * - `search/`     embeddings, BM25, the in-memory graph, visibility-scoped queries.
 * - `linking/`    the coalesced run queue, the myKG child, the inbox, worker sessions.
 * - `visibility`  which collections a calling chat can see (its profile).
 * - `service.ts`  composes them; `routes*.ts` serve them.
 *
 * Each module implements its port and receives the others through these
 * interfaces only, so they can be built and tested apart.
 */

import type {
  KnowledgeEntry,
  KnowledgeEntryMeta,
  KnowledgeLinkState,
  KnowledgeLinkingState,
  KnowledgeSettings,
  KnowledgeVisibility
} from "@orquester/api";

// ---------------------------------------------------------------------------
// install/
// ---------------------------------------------------------------------------

/** An installed, smoke-tested runtime. */
export interface KnowledgeRuntime {
  /** The pinned myKG version, e.g. "0.4.10". */
  mykgVersion: string;
  /** Absolute path of the `mykg` entry point inside the venv. */
  mykgBin: string;
  /** The venv's python (for the rare helper that needs it). */
  pythonBin: string;
  /** Directory holding the embedding model files (local, hash-checked). */
  embeddingModelDir: string;
  /** e.g. "Xenova/all-MiniLM-L6-v2". */
  embeddingModelId: string;
  /** Embedding vector length. */
  embeddingDimensions: number;
  /**
   * False while myKG runs but the model's files are not in place (a runtime installed with an
   * older model, until the next update check fetches this one): no embeddings, search runs on
   * text and the graph. Absent: ready.
   */
  embeddingModelReady?: boolean;
  /** Put before a query / a stored chunk when embedded (e5: "query: " / "passage: "); absent: none. */
  embeddingQueryPrefix?: string;
  embeddingPassagePrefix?: string;
  /** Tokens per input, special tokens included; absent: 256. */
  embeddingMaxTokens?: number;
  /** The model's cosine cut-offs; absent: all-MiniLM-L6-v2's. */
  embeddingThresholds?: KnowledgeVectorThresholds;
  /**
   * tiktoken's cache dir (`TIKTOKEN_CACHE_DIR` of every myKG child), filled with the
   * encodings myKG loads at install time, so a linking run never fetches one.
   */
  tiktokenCacheDir: string;
}

export interface KnowledgeRuntimePort {
  /** The active runtime, or null while not installed. */
  current(): KnowledgeRuntime | null;
  onChange(listener: (runtime: KnowledgeRuntime | null) => void): () => void;
}

export interface KnowledgeSettingsPort {
  /** Whether the plugin is enabled on this server. */
  enabled(): boolean;
  get(): KnowledgeSettings;
  onChange(listener: () => void): () => void;
}

// ---------------------------------------------------------------------------
// store/
// ---------------------------------------------------------------------------

/**
 * - `added` / `deleted` — entries created or removed.
 * - `edited` — fields that reach the myKG input file changed (body, title,
 *   kind, author, handle, postedAt): the entry needs re-linking.
 * - `relabelled` — only collections changed: never re-linked.
 */
export interface KnowledgeEntryChange {
  kind: "added" | "edited" | "deleted" | "relabelled";
  entryIds: string[];
}

export interface KnowledgeStorePort {
  /** Every entry's metadata (no bodies), from memory. */
  listMeta(): readonly KnowledgeEntryMeta[];
  getMeta(id: string): KnowledgeEntryMeta | null;
  getEntry(id: string): Promise<KnowledgeEntry | null>;
  /** The directory myKG reads; the store keeps one `<entryId>.md` per entry in sync. */
  readonly mykgInputDir: string;
  setLinkState(ids: readonly string[], state: KnowledgeLinkState): Promise<void>;
  onChange(listener: (change: KnowledgeEntryChange) => void): () => void;
}

// ---------------------------------------------------------------------------
// search/
// ---------------------------------------------------------------------------

export interface KnowledgeGraphPort {
  /**
   * Load myKG's `nodes.jsonl` / `edges.jsonl` from a session's output dir and
   * swap them in atomically (in-flight queries keep the old graph).
   */
  load(outputDir: string): Promise<{ nodes: number; edges: number }>;
  counts(): { nodes: number; edges: number };
  /** The whole graph's concept types → how many concepts each has (the rebuild estimate reads it). */
  conceptTypes(): ReadonlyMap<string, number>;
}

/** Cosine cut-offs of the model behind a {@link KnowledgeVectorIndex} (`search/embedder.ts` restates it). */
export interface KnowledgeVectorThresholds {
  minimum: number;
  good: number;
  strong: number;
  duplicate: number;
}

/** One entry's best-matching chunk for a query vector. */
export interface KnowledgeVectorHit {
  entryId: string;
  /** Cosine similarity of the best chunk (vectors are L2-normalized). */
  score: number;
  /** Index of the best chunk, and how many the entry has. */
  chunk: number;
  chunks: number;
  /** The best chunk's character range in the entry body. */
  span: { start: number; end: number };
}

/**
 * Vector storage and nearest-neighbour search over entry chunks (retrieval spec docs/superpowers/
 * specs/2026-10-27-knowledge-retrieval-phase0-1-design.md, "The vector index port"). The
 * in-process implementation (`search/vector-index.ts`) is the only one today; a Qdrant-backed one
 * can implement the same port later. Every call is synchronous except embedding a query, so a
 * caller can scope with a predicate while ranking (spec goal: visibility inside search).
 */
export interface KnowledgeVectorIndex {
  /** The model the current vectors come from; null while no embedder is usable. */
  modelId(): string | null;
  /** That model's cut-offs; null while no embedder is usable. */
  thresholds(): KnowledgeVectorThresholds | null;
  /** Embed search text as a query; null when embeddings are unavailable (callers fall back to text). */
  embedQuery(text: string): Promise<Float32Array | null>;
  /**
   * Best chunk per entry, cosine ≥ `minimum` (default: the model's `minimum`), best first, at most
   * `limit`; only entries `accept` passes are scored.
   */
  search(query: Float32Array, accept: (entryId: string) => boolean, limit: number, minimum?: number): KnowledgeVectorHit[];
  /** The L2-normalized mean of an entry's chunk vectors; null when it has none (yet). */
  entryVector(entryId: string): Float32Array | null;
  /** Entries that have vectors from the current model. */
  embeddedIds(): string[];
  /** Bumped whenever any entry's vectors change: a cache key for derived views (similarity graph). */
  generation(): number;
}

// ---------------------------------------------------------------------------
// linking/
// ---------------------------------------------------------------------------

export interface KnowledgeLinkingPort {
  status(): KnowledgeLinkingState;
  /** A store change; schedules a coalesced run when it needs linking. */
  entriesChanged(change: KnowledgeEntryChange): void;
}

// ---------------------------------------------------------------------------
// visibility
// ---------------------------------------------------------------------------

export interface KnowledgeVisibilityPort {
  /**
   * What the calling chat can see: `all` with no session (the user in the UI)
   * or a session without a profile; else its profile's `knowledgeCollections`.
   */
  forSession(sessionId: string | undefined): Promise<KnowledgeVisibility>;
}
