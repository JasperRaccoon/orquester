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
